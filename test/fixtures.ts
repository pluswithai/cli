import type { RunResult } from "../src/client.js";

export const run = (over: Partial<RunResult> = {}): RunResult => ({
  id: "r1",
  project: "u::shop",
  testFiles: ["tests/a.spec.ts"],
  status: "passed",
  exitCode: 0,
  stdout: "",
  stderr: "",
  duration: 1000,
  timestamp: 1,
  scheduled: false,
  ...over,
});
