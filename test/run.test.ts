import { describe, expect, it, vi } from "vitest";
import { ApiError, type RunResult } from "../src/client.js";
import { executeRun, exitCodeFor, NoTestsError, type RunClient } from "../src/run.js";
import { run } from "./fixtures.js";

/** A fake API whose runs advance through scripted statuses, one per poll. */
function fakeClient(script: Record<string, Array<RunResult["status"] | Error>>, opts: { files?: string[] } = {}) {
  const polls: Record<string, number> = {};
  const client: RunClient & { started: Array<{ tests: string[]; region?: string }> } = {
    started: [],
    testFiles: vi.fn(async () => opts.files ?? Object.keys(script)),
    startRun: vi.fn(async (_p: string, tests: string[], region?: string) => {
      client.started.push({ tests, region });
      return tests.map((t) => run({ id: `id-${t}`, testFiles: [t], status: "queued" }));
    }),
    run: vi.fn(async (_p: string, id: string) => {
      const file = id.replace(/^id-/, "");
      const steps = script[file] ?? ["passed"];
      const i = Math.min(polls[file] ?? 0, steps.length - 1);
      polls[file] = (polls[file] ?? 0) + 1;
      const step = steps[i]!;
      if (step instanceof Error) throw step;
      return run({ id, testFiles: [file], status: step, duration: 2000 });
    }),
  };
  return client;
}

function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

const opts = (over: Partial<Parameters<typeof executeRun>[1]> = {}) => ({
  project: "shop",
  tests: [] as string[],
  timeoutMs: 60_000,
  intervalMs: 5_000,
  ...over,
});

describe("executeRun", () => {
  it("runs every test file of the project, polls until done, exit 0 when all pass", async () => {
    const client = fakeClient({ "a.spec.ts": ["running", "passed"], "b.spec.ts": ["passed"] });
    const c = clock();
    const finished: string[] = [];
    const started = vi.fn();
    const outcome = await executeRun(
      { client, ...c, onStarted: started, onFinished: (r) => finished.push(r.testFiles[0]!) },
      opts(),
    );
    expect(client.started).toEqual([{ tests: ["a.spec.ts", "b.spec.ts"], region: undefined }]);
    expect(started).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "id-a.spec.ts" })]));
    expect(finished).toEqual(["b.spec.ts", "a.spec.ts"]);
    // Results keep the order the runs were started in, not the order they finished.
    expect(outcome.results.map((r) => r.testFiles[0])).toEqual(["a.spec.ts", "b.spec.ts"]);
    expect(outcome).toMatchObject({ pending: [], timedOut: false, exitCode: 0 });
    expect(c.sleeps).toEqual([5000, 5000]);
  });

  it("uses the given tests and region instead of listing the project", async () => {
    const client = fakeClient({});
    await executeRun({ client, ...clock() }, opts({ tests: ["only.spec.ts"], region: "weur" }));
    expect(client.testFiles).not.toHaveBeenCalled();
    expect(client.started).toEqual([{ tests: ["only.spec.ts"], region: "weur" }]);
  });

  it("works without progress callbacks", async () => {
    const outcome = await executeRun({ client: fakeClient({ "a.spec.ts": ["passed"] }), ...clock() }, opts());
    expect(outcome.exitCode).toBe(0);
  });

  it("counts a run that is already final when started", async () => {
    const client = fakeClient({});
    client.startRun = vi.fn(async () => [run({ id: "done", status: "failed" })]);
    const finished = vi.fn();
    const outcome = await executeRun({ client, ...clock(), onFinished: finished }, opts({ tests: ["x.spec.ts"] }));
    expect(finished).toHaveBeenCalledTimes(1);
    expect(client.run).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(1);
  });

  it("refuses a project with no test files", async () => {
    const client = fakeClient({}, { files: [] });
    await expect(executeRun({ client, ...clock() }, opts())).rejects.toBeInstanceOf(NoTestsError);
  });

  it("retries the start on 429, waiting what the API says (capped), at most 3 times", async () => {
    const client = fakeClient({ "a.spec.ts": ["passed"] });
    const real = client.startRun;
    let calls = 0;
    client.startRun = vi.fn(async (...args: Parameters<RunClient["startRun"]>) => {
      calls += 1;
      if (calls === 1) throw new ApiError("429 busy", 429, true, 7);
      if (calls === 2) throw new ApiError("429 busy", 429, true, 600);
      if (calls === 3) throw new ApiError("429 busy", 429, true);
      return real(...args);
    });
    const c = clock();
    const notices: string[] = [];
    const outcome = await executeRun({ client, ...c, onNotice: (m) => notices.push(m) }, opts());
    expect(c.sleeps.slice(0, 3)).toEqual([7000, 60_000, 10_000]);
    expect(notices[0]).toMatch(/retrying in 7s/);
    expect(outcome.exitCode).toBe(0);
  });

  it("gives up after the 3rd retry", async () => {
    const client = fakeClient({});
    client.startRun = vi.fn(async () => { throw new ApiError("429 busy", 429, true, 1); });
    await expect(executeRun({ client, ...clock() }, opts({ tests: ["a"] }))).rejects.toMatchObject({ status: 429 });
    expect(client.startRun).toHaveBeenCalledTimes(4);
  });

  it("does not retry other start errors", async () => {
    const client = fakeClient({});
    client.startRun = vi.fn(async () => { throw new ApiError("403 nope", 403, false); });
    await expect(executeRun({ client, ...clock() }, opts({ tests: ["a"] }))).rejects.toMatchObject({ status: 403 });
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });

  it("tolerates transient poll errors, resetting on success", async () => {
    const flaky = new ApiError("502 bad gateway", 502, true);
    const client = fakeClient({ "a.spec.ts": [flaky, flaky, flaky, "running", flaky, "passed"] });
    const notices: string[] = [];
    const outcome = await executeRun({ client, ...clock(), onNotice: (m) => notices.push(m) }, opts());
    expect(outcome.exitCode).toBe(0);
    expect(notices.some((n) => n.includes("502 bad gateway"))).toBe(true);
  });

  it("fails on the 4th consecutive transient poll error", async () => {
    const flaky = new ApiError("Could not reach api: fetch failed", 0, true);
    const client = fakeClient({ "a.spec.ts": [flaky, flaky, flaky, flaky] });
    await expect(executeRun({ client, ...clock() }, opts())).rejects.toBe(flaky);
  });

  it("fails at once on a non-transient poll error", async () => {
    const gone = new ApiError("404 run not found", 404, false);
    const client = fakeClient({ "a.spec.ts": [gone] });
    await expect(executeRun({ client, ...clock() }, opts())).rejects.toBe(gone);
  });

  it("rethrows a non-API poll error", async () => {
    const client = fakeClient({ "a.spec.ts": [new TypeError("bug")] });
    await expect(executeRun({ client, ...clock() }, opts())).rejects.toBeInstanceOf(TypeError);
  });

  it("times out, reporting what was still running (exit 4)", async () => {
    const client = fakeClient({ "a.spec.ts": ["running"], "b.spec.ts": ["passed"] });
    const outcome = await executeRun({ client, ...clock() }, opts({ timeoutMs: 12_000 }));
    expect(outcome.timedOut).toBe(true);
    expect(outcome.pending.map((r) => r.testFiles[0])).toEqual(["a.spec.ts"]);
    expect(outcome.pending[0]!.status).toBe("running");
    expect(outcome.results.map((r) => r.testFiles[0])).toEqual(["b.spec.ts"]);
    expect(outcome.exitCode).toBe(4);
  });
});

describe("exitCodeFor", () => {
  it("failed beats error beats timeout beats success", () => {
    expect(exitCodeFor([run({ status: "passed" })], false)).toBe(0);
    expect(exitCodeFor([run({ status: "passed" })], true)).toBe(4);
    expect(exitCodeFor([run({ status: "error" })], true)).toBe(3);
    expect(exitCodeFor([run({ status: "error" }), run({ status: "failed" })], true)).toBe(1);
  });
});
