/**
 * action.yml (the GitHub Action) is checked twice: parsed as YAML the way
 * GitHub loads it (a stray ": " in a description once made it unloadable),
 * and its `run:` script executed with a fake `npx` that records its arguments.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const ACTION = readFileSync(new URL("../action.yml", import.meta.url), "utf8");

interface ActionManifest {
  name: string;
  description: string;
  inputs: Record<string, { description: string; required?: boolean; default?: string }>;
  runs: { using: string; steps: Array<{ shell: string; env: Record<string, string>; run: string }> };
}
const manifest = parse(ACTION, { strict: true }) as ActionManifest;
const step = manifest.runs.steps[0]!;
const script = step.run;

function runAction(env: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "pwai-action-"));
  const out = join(dir, "args.txt");
  writeFileSync(join(dir, "npx"), `#!/bin/bash\nprintf '%s\\n' "$@" > "${out}"\n`);
  chmodSync(join(dir, "npx"), 0o755);
  const base = { PWAI_PROJECT: "shop", PWAI_TESTS: "", PWAI_ENVIRONMENT: "", PWAI_BASE_URL: "", PWAI_REGION: "", PWAI_TIMEOUT: "1800", PWAI_JUNIT: "", PWAI_VERSION: "0", PLUSWITHAI_API_URL: "" };
  execFileSync("bash", ["-c", script], { env: { PATH: `${dir}:${process.env.PATH}`, ...base, ...env } });
  return readFileSync(out, "utf8").trimEnd().split("\n");
}

describe("action.yml", () => {
  it("is a valid composite action manifest", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.description).toBeTruthy();
    expect(manifest.runs.using).toBe("composite");
    expect(step.shell).toBe("bash");
  });

  it("declares the inputs a workflow needs, api-key and project required", () => {
    expect(Object.keys(manifest.inputs)).toEqual([
      "api-key", "project", "tests", "environment", "base-url", "region", "timeout", "junit", "api-url", "version",
    ]);
    expect(manifest.inputs["api-key"]!.required).toBe(true);
    expect(manifest.inputs.project!.required).toBe(true);
    for (const [name, input] of Object.entries(manifest.inputs)) {
      expect(typeof input.description, name).toBe("string");
      if (!input.required) expect(typeof input.default, name).toBe("string");
    }
  });

  it("maps every input into the step's env", () => {
    expect(step.env.PLUSWITHAI_API_KEY).toBe("${{ inputs.api-key }}");
    expect(step.env.PLUSWITHAI_API_URL).toBe("${{ inputs.api-url }}");
    expect(step.env.PWAI_BASE_URL).toBe("${{ inputs.base-url }}");
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

  it("leaves the API URL to the CLI's default unless one is given", () => {
    expect(runAction({ PLUSWITHAI_API_URL: "" })).not.toContain("--api-url");
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
