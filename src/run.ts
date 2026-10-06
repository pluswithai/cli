/**
 * `pluswithai run`: start → poll → verdict (SPEC.md §2.1, §3). Time and
 * sleeping are injected so the whole loop runs instantly under test.
 */
import { ApiError, type RunResult } from "./client.js";

export const MAX_START_RETRIES = 3;
export const MAX_POLL_FAILURES = 3;
export const DEFAULT_RETRY_AFTER_SECONDS = 10;
export const MAX_RETRY_AFTER_SECONDS = 60;

export interface RunClient {
  testFiles(project: string): Promise<string[]>;
  startRun(project: string, tests: string[], region?: string): Promise<RunResult[]>;
  run(project: string, id: string): Promise<RunResult>;
}

export interface RunDeps {
  client: RunClient;
  sleep(ms: number): Promise<void>;
  now(): number;
  onStarted?(runs: RunResult[]): void;
  onFinished?(run: RunResult): void;
  onNotice?(message: string): void;
}

export interface RunOptions {
  project: string;
  /** Empty = every test file of the project. */
  tests: string[];
  region?: string;
  timeoutMs: number;
  intervalMs: number;
}

export interface RunOutcome {
  /** Finished runs, in the order they were started. */
  results: RunResult[];
  /** Runs still queued or running when the deadline hit. */
  pending: RunResult[];
  timedOut: boolean;
  exitCode: number;
}

export class NoTestsError extends Error {
  constructor(project: string) {
    super(`Project "${project}" has no test files to run.`);
    this.name = "NoTestsError";
  }
}

const isFinal = (r: RunResult) => r.status === "passed" || r.status === "failed" || r.status === "error";

/** failed (1) beats error (3) beats timeout (4) beats success (0). */
export function exitCodeFor(results: RunResult[], timedOut: boolean): number {
  if (results.some((r) => r.status === "failed")) return 1;
  if (results.some((r) => r.status === "error")) return 3;
  return timedOut ? 4 : 0;
}

async function start(deps: RunDeps, opts: RunOptions, tests: string[]): Promise<RunResult[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.client.startRun(opts.project, tests, opts.region);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 429 || attempt >= MAX_START_RETRIES) throw e;
      const wait = Math.min(e.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS, MAX_RETRY_AFTER_SECONDS);
      deps.onNotice?.(`${e.message}; retrying in ${wait}s`);
      await deps.sleep(wait * 1000);
    }
  }
}

export async function executeRun(deps: RunDeps, opts: RunOptions): Promise<RunOutcome> {
  const tests = opts.tests.length > 0 ? opts.tests : await deps.client.testFiles(opts.project);
  if (tests.length === 0) throw new NoTestsError(opts.project);

  const started = await start(deps, opts, tests);
  // Counted from here, not from the call: waiting out a 429 is not time
  // the runs had to finish in.
  const deadline = deps.now() + opts.timeoutMs;
  deps.onStarted?.(started);

  const latest = new Map<string, RunResult>(started.map((r) => [r.id, r]));
  for (const r of started) if (isFinal(r)) deps.onFinished?.(r);

  let failures = 0;
  let timedOut = false;
  while ([...latest.values()].some((r) => !isFinal(r))) {
    if (deps.now() >= deadline) {
      timedOut = true;
      break;
    }
    await deps.sleep(opts.intervalMs);
    for (const r of [...latest.values()].filter((x) => !isFinal(x))) {
      try {
        const fresh = await deps.client.run(opts.project, r.id);
        failures = 0;
        latest.set(r.id, fresh);
        if (isFinal(fresh)) deps.onFinished?.(fresh);
      } catch (e) {
        if (!(e instanceof ApiError) || !e.transient) throw e;
        failures += 1;
        if (failures > MAX_POLL_FAILURES) throw e;
        deps.onNotice?.(`Checking ${r.testFiles.join(", ")} failed (${e.message}); retrying`);
      }
    }
  }

  const all = [...latest.values()];
  const results = all.filter(isFinal);
  const pending = all.filter((r) => !isFinal(r));
  return { results, pending, timedOut, exitCode: exitCodeFor(results, timedOut) };
}
