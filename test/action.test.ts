/**
 * action.yml (the GitHub Action) is shell, so it is checked by running the
 * exact `run:` script with a fake `npx` that records its arguments.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACTION = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
const script = ACTION.slice(ACTION.indexOf("      run: |\n") + "      run: |\n".length)
  .split("\n")
  .map((l) => l.replace(/^ {8}/, ""))
  .join("\n");

function runAction(env: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "pwai-action-"));
  const out = join(dir, "args.txt");
  writeFileSync(join(dir, "npx"), `#!/bin/bash\nprintf '%s\\n' "$@" > "${out}"\n`);
  chmodSync(join(dir, "npx"), 0o755);
  const base = { PWAI_PROJECT: "shop", PWAI_TESTS: "", PWAI_ENVIRONMENT: "", PWAI_BASE_URL: "", PWAI_REGION: "", PWAI_TIMEOUT: "1800", PWAI_JUNIT: "", PWAI_VERSION: "0" };
  execFileSync("bash", ["-c", script], { env: { PATH: `${dir}:${process.env.PATH}`, ...base, ...env } });
  return readFileSync(out, "utf8").trimEnd().split("\n");
}

describe("action.yml", () => {
  it("declares the inputs a workflow needs, api-key and project required", () => {
    for (const input of ["api-key", "project", "tests", "environment", "base-url", "region", "timeout", "junit", "version"]) {
      expect(ACTION).toContain(`\n  ${input}:\n`);
    }
    expect(ACTION).toMatch(/api-key:\n {4}description:[^\n]*\n {4}required: true/);
    expect(ACTION).toMatch(/project:\n {4}description:[^\n]*\n {4}required: true/);
  });

  it("never interpolates an input inside the script (only through env)", () => {
    expect(script).not.toContain("${{");
  });

  it("runs every test file of the project by default", () => {
    expect(runAction({})).toEqual(["-y", "@pluswithai/cli@0", "run", "--project", "shop", "--timeout", "1800"]);
  });

  it("passes tests (one per line), environment, region and junit", () => {
    expect(runAction({ PWAI_TESTS: "tests/a.spec.ts\n  tests/b.spec.ts \n\n", PWAI_ENVIRONMENT: "staging", PWAI_REGION: "weur", PWAI_JUNIT: "out.xml", PWAI_VERSION: "0.3.0" })).toEqual([
      "-y", "@pluswithai/cli@0.3.0", "run", "--project", "shop", "--timeout", "1800",
      "--test", "tests/a.spec.ts", "--test", "tests/b.spec.ts", "--env", "staging", "--region", "weur", "--junit", "out.xml",
    ]);
  });

  it("passes a preview deploy URL", () => {
    expect(runAction({ PWAI_BASE_URL: "https://shop-git-x.vercel.app" })).toContain("--base-url");
  });

  it("keeps hostile input as data, not shell code", () => {
    const args = runAction({ PWAI_PROJECT: "shop; touch /tmp/pwned-by-action", PWAI_BASE_URL: "$(whoami)" });
    expect(args).toContain("shop; touch /tmp/pwned-by-action");
    expect(args).toContain("$(whoami)");
  });
});
