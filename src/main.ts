/**
 * Wires args, config, client, run and report together and turns every
 * outcome into an exit code (SPEC.md §3). All I/O arrives through MainDeps,
 * so this whole file is tested without a network or a real process.
 */
import { helpText, parseCommand, UsageError, type Command } from "./args.js";
import { ApiError, Client } from "./client.js";
import { ConfigError, redact, resolveConfig, type Config, type Env } from "./config.js";
import {
  annotations,
  junitXml,
  markdownSummary,
  progressLine,
  projectsText,
  runJson,
  runsText,
  startedLine,
  summaryText,
  testsText,
  whoamiText,
} from "./report.js";
import { executeRun, NoTestsError } from "./run.js";
import { runMcpProxy } from "./mcp-proxy.js";
import { VERSION } from "./version.js";

export interface MainDeps {
  argv: string[];
  env: Env;
  fetch: typeof fetch;
  stdout(text: string): void;
  stderr(text: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  writeFile(path: string, data: string): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  /** stdin, one line at a time — the MCP stdio transport. */
  stdinLines(): AsyncIterable<string>;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, api: 3, timeout: 4 } as const;

const line = (text: string) => `${text}\n`;
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function main(deps: MainDeps): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(deps.argv);
  } catch (e) {
    const err = e as UsageError;
    deps.stderr(line(`error: ${err.message}`));
    deps.stderr(line(`Run "pluswithai ${err.topic ? `${err.topic} ` : ""}--help" for usage.`));
    return EXIT.usage;
  }

  if (command.kind === "help") {
    deps.stdout(line(helpText(command.topic)));
    return EXIT.ok;
  }
  if (command.kind === "version") {
    deps.stdout(line(VERSION));
    return EXIT.ok;
  }

  let config: Config;
  try {
    config = resolveConfig(command.global, deps.env);
  } catch (e) {
    deps.stderr(line(`error: ${(e as ConfigError).message}`));
    return EXIT.usage;
  }

  const client = new Client({ apiUrl: config.apiUrl, apiKey: config.apiKey, fetch: deps.fetch });
  const print = (json: boolean, value: unknown, text: string) => deps.stdout(line(json ? JSON.stringify(value, null, 2) : text));

  try {
    switch (command.kind) {
      case "whoami": {
        const me = await client.me();
        print(command.json, me, whoamiText(me, config.apiUrl));
        return EXIT.ok;
      }
      case "projects": {
        const projects = await client.projects();
        print(command.json, projects, projectsText(projects, config.appUrl));
        return EXIT.ok;
      }
      case "tests": {
        const files = await client.testFiles(command.project);
        print(command.json, files, testsText(command.project, files));
        return EXIT.ok;
      }
      case "runs": {
        const runs = await client.runs(command.project, command.limit);
        print(command.json, runs, runsText(command.project, runs));
        return EXIT.ok;
      }
      case "run":
        return await runCommand(deps, config, client, command);
      case "mcp":
        deps.stderr(line(`Pluswithai MCP proxy → ${config.apiUrl}/mcp`));
        return await runMcpProxy({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
          fetch: deps.fetch,
          write: (text) => deps.stdout(line(text)),
          log: (text) => deps.stderr(line(text)),
          lines: deps.stdinLines(),
        });
    }
  } catch (e) {
    if (e instanceof NoTestsError) {
      deps.stderr(line(`error: ${e.message}`));
      return EXIT.usage;
    }
    if (e instanceof ApiError) {
      deps.stderr(line(`error: ${e.message}`));
      const hint = hintFor(e, command);
      if (hint) deps.stderr(line(hint));
      return EXIT.api;
    }
    deps.stderr(line(`unexpected error: ${redact(describe(e), config.apiKey)}`));
    return EXIT.api;
  }
}

function hintFor(e: ApiError, command: Command): string | null {
  if (e.status === 401) return "Check PLUSWITHAI_API_KEY (create one on the app's API keys page).";
  if (e.status === 403 && command.kind === "run") return "Starting runs needs a key with CI (read + run) access.";
  if (e.status === 404 && "project" in command) return `Check the project name "${command.project}" (pluswithai projects lists them).`;
  return null;
}

async function runCommand(
  deps: MainDeps,
  config: Config,
  client: Client,
  command: Extract<Command, { kind: "run" }>,
): Promise<number> {
  const outcome = await executeRun(
    {
      client,
      sleep: deps.sleep,
      now: deps.now,
      onStarted: (runs) => deps.stderr(line(startedLine(command.project, runs.length))),
      onFinished: (r) => deps.stderr(line(progressLine(r))),
      onNotice: (message) => deps.stderr(line(message)),
    },
    {
      project: command.project,
      tests: command.tests,
      region: command.region,
      environment: command.environment,
      baseUrl: command.baseUrl,
      timeoutMs: command.timeoutSec * 1000,
      intervalMs: command.intervalSec * 1000,
    },
  );

  if (command.json) deps.stdout(line(JSON.stringify(runJson(outcome, command.project, config.appUrl), null, 2)));
  else deps.stdout(line(summaryText(outcome, command.project, config.appUrl)));

  if (deps.env.GITHUB_ACTIONS === "true") for (const a of annotations(outcome)) deps.stdout(line(a));

  const summaryPath = deps.env.GITHUB_STEP_SUMMARY;
  if (command.summary && summaryPath) {
    await deps
      .appendFile(summaryPath, markdownSummary(outcome, command.project, config.appUrl))
      .catch((e: unknown) => deps.stderr(line(`warning: could not write the GitHub step summary: ${describe(e)}`)));
  }

  if (command.junit) {
    const path = command.junit;
    await deps.writeFile(path, junitXml(outcome, command.project)).then(
      () => deps.stderr(line(`JUnit report written to ${path}`)),
      (e: unknown) => deps.stderr(line(`warning: could not write the JUnit report to ${path}: ${describe(e)}`)),
    );
  }
  return outcome.exitCode;
}
