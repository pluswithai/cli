import { describe, expect, it, vi } from "vitest";
import { main, type MainDeps } from "../src/main.js";
import { VERSION } from "../src/version.js";
import { run } from "./fixtures.js";
import type { RunResult } from "../src/client.js";

const KEY = "pwai_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

interface FakeApi {
  files?: string[];
  /** Status sequence per test file, one per poll. */
  script?: Record<string, RunResult["status"][]>;
  /** Override any route: return a Response to short-circuit. */
  route?: (method: string, path: string) => Response | undefined;
  /** Exit code per spawned command ("npm", "npx playwright install", "npx playwright test"). */
  spawn?: (command: string, args: string[]) => number;
}

const b64 = (text: string) => Buffer.from(text).toString("base64");
const EXPORT = {
  headOid: "abc123",
  files: [
    { path: "playwright.config.ts", base64: b64("export default {};\n"), size: 19 },
    { path: "tests/checkout.spec.ts", base64: b64("test('x', () => {});\n"), size: 21 },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function harness(argv: string[], api: FakeApi = {}, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, string> = {};
  const disk: Record<string, string> = {};
  const spawned: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string | undefined> }> = [];
  const polls: Record<string, number> = {};
  let t = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname);
    const custom = api.route?.(method, path);
    if (custom) return custom;
    if (path === "/mcp") {
      const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
      return msg.id === undefined ? new Response(null, { status: 202 }) : json({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method } });
    }
    if (path === "/me") return json({ userId: "u1", email: null, isAdmin: false });
    if (path === "/projects/shop/export") return json(EXPORT);
    if (path === "/projects") return json({ projects: [{ name: "shop", url: "https://shop.example", createdAt: "2026-01-02T00:00:00Z" }] });
    if (path === "/projects/shop/test-files") return json({ files: api.files ?? Object.keys(api.script ?? {}) });
    if (path === "/projects/shop/runs" && method === "GET") return json({ runs: [run({ id: "old" })], total: 1 });
    if (path === "/projects/shop/run-tests" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { tests: string[] };
      return json({ results: body.tests.map((f) => run({ id: `id-${f}`, testFiles: [f], status: "queued" })), async: true }, 202);
    }
    const m = path.match(/^\/projects\/shop\/runs\/id-(.+)$/);
    if (m) {
      const file = m[1]!;
      const steps = api.script?.[file] ?? ["passed"];
      const i = Math.min(polls[file] ?? 0, steps.length - 1);
      polls[file] = (polls[file] ?? 0) + 1;
      return json({
        run: run({ id: `id-${file}`, testFiles: [file], status: steps[i]!, duration: 3000, stdout: steps[i] === "failed" ? "Error: boom" : "" }),
        artifacts: [],
      });
    }
    return json({ error: `no route ${method} ${path}` }, 404);
  });
  const deps: MainDeps = {
    argv,
    env: { PLUSWITHAI_API_KEY: KEY, ...env },
    fetch: fetchFn as unknown as typeof fetch,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    sleep: async (ms) => { t += ms; },
    now: () => t,
    stdinLines: async function* () {},
    writeFile: async (p, d) => { files[p] = d; },
    appendFile: async (p, d) => { files[p] = (files[p] ?? "") + d; },
    readText: async (p) => disk[p] ?? null,
    writeBytes: async (p, bytes) => { disk[p] = new TextDecoder().decode(bytes); },
    remove: async (p) => { delete disk[p]; },
    exists: async (p) => p in disk || Object.keys(disk).some((k) => k.startsWith(`${p}/`)),
    spawn: async (command, args, opts) => {
      spawned.push({ command, args, cwd: opts.cwd, env: opts.env });
      return api.spawn?.(command, args) ?? 0;
    },
  };
  return { deps, out: () => out.join(""), err: () => err.join(""), files, disk, spawned, fetchFn };
}

describe("main — meta", () => {
  it("prints help and exits 0, without needing a key", async () => {
    const h = harness(["--help"], {}, { PLUSWITHAI_API_KEY: undefined });
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toContain("Usage");
  });

  it("prints a command's help", async () => {
    const h = harness(["run", "--help"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toContain("--junit");
  });

  it("prints the version", async () => {
    const h = harness(["--version"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toBe(`${VERSION}\n`);
  });

  it("usage errors exit 2 with a pointer to help", async () => {
    const h = harness(["deploy"]);
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain('error: Unknown command "deploy"');
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("a command's usage error points at that command's help", async () => {
    const h = harness(["runs"]);
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain("pluswithai runs --help");
  });

  it("a missing key exits 2 before any request", async () => {
    const h = harness(["projects"], {}, { PLUSWITHAI_API_KEY: undefined });
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain("PLUSWITHAI_API_KEY");
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});

describe("main — read commands", () => {
  it("whoami", async () => {
    const h = harness(["whoami"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toContain("account u1");
  });

  it("whoami --json", async () => {
    const h = harness(["whoami", "--json"]);
    await main(h.deps);
    expect(JSON.parse(h.out())).toEqual({ userId: "u1", email: null, isAdmin: false });
  });

  it("projects, as text and JSON", async () => {
    const h = harness(["projects"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toContain("https://shop.example");
    const j = harness(["projects", "--json"]);
    await main(j.deps);
    expect(JSON.parse(j.out())[0].name).toBe("shop");
  });

  it("tests, as text and JSON", async () => {
    const h = harness(["tests", "--project", "shop"], { files: ["tests/a.spec.ts"] });
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toBe("tests/a.spec.ts\n");
    const j = harness(["tests", "-p", "shop", "--json"], { files: ["x"] });
    await main(j.deps);
    expect(JSON.parse(j.out())).toEqual(["x"]);
  });

  it("runs, as text and JSON", async () => {
    const h = harness(["runs", "--project", "shop", "--limit", "3"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toContain("old");
    expect(String(h.fetchFn.mock.calls[0]![0])).toContain("limit=3");
    const j = harness(["runs", "-p", "shop", "--json"]);
    await main(j.deps);
    expect(JSON.parse(j.out())[0].id).toBe("old");
  });

  it("honours --api-url", async () => {
    const h = harness(["whoami", "--api-url", "http://localhost:8787"]);
    await main(h.deps);
    expect(String(h.fetchFn.mock.calls[0]![0])).toBe("http://localhost:8787/me");
  });
});

describe("main — API errors", () => {
  it("401 exits 3 with a hint about the key, never the key itself", async () => {
    const h = harness(["projects"], { route: () => json({ error: `Invalid or revoked API key ${KEY}` }, 401) });
    expect(await main(h.deps)).toBe(3);
    expect(h.err()).toContain("401 Invalid or revoked API key");
    expect(h.err()).toContain("the app's API keys page");
    expect(h.err()).not.toContain(KEY);
  });

  it("403 on run explains the scope", async () => {
    const h = harness(["run", "-p", "shop", "-t", "a.spec.ts"], {
      route: (m) => (m === "POST" ? json({ error: 'This API key does not have the "run" scope.' }, 403) : undefined),
    });
    expect(await main(h.deps)).toBe(3);
    expect(h.err()).toContain("CI / CLI (read + run)");
  });

  it("403 elsewhere has no scope hint", async () => {
    const h = harness(["projects"], { route: () => json({ error: "This account has been suspended." }, 403) });
    expect(await main(h.deps)).toBe(3);
    expect(h.err()).not.toContain("CI / CLI (read + run)");
  });

  it("404 names the project", async () => {
    const h = harness(["tests", "-p", "nope"], { route: () => json({ error: "project not found" }, 404) });
    expect(await main(h.deps)).toBe(3);
    expect(h.err()).toContain('Check the project name "nope"');
  });

  it("unexpected errors exit 3 and are redacted", async () => {
    const h = harness(["projects"]);
    h.deps.fetch = (() => { throw new RangeError(`weird ${KEY}`); }) as unknown as typeof fetch;
    // A RangeError thrown synchronously by fetch is still a network failure to the client…
    expect(await main(h.deps)).toBe(3);
    // …but a bug in our own code path surfaces as "unexpected".
    const bug = harness(["projects"]);
    bug.deps.stdout = () => { throw new Error(`stdout closed ${KEY}`); };
    expect(await main(bug.deps)).toBe(3);
    expect(bug.err()).toContain("unexpected error: stdout closed pwai_…");
  });

  it("a non-Error throw is reported too", async () => {
    const h = harness(["projects"]);
    h.deps.stdout = () => { throw "string thrown"; };
    expect(await main(h.deps)).toBe(3);
    expect(h.err()).toContain("unexpected error: string thrown");
  });
});

describe("main — run", () => {
  it("runs every file, prints progress on stderr and a summary on stdout, exit 0", async () => {
    const h = harness(["run", "--project", "shop"], { script: { "a.spec.ts": ["running", "passed"], "b.spec.ts": ["passed"] } });
    expect(await main(h.deps)).toBe(0);
    expect(h.err()).toContain("Started 2 runs in shop");
    expect(h.err()).toContain("✓ a.spec.ts  passed  3.0s");
    expect(h.out()).toContain("2 passed");
    expect(h.out()).toContain("https://pluswithai.com/app?project=shop");
  });

  it("exit 1 on a failed run; annotations and step summary in GitHub Actions; JUnit written", async () => {
    const h = harness(
      ["run", "-p", "shop", "--junit", "junit.xml"],
      { script: { "a.spec.ts": ["failed"] } },
      { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: "/tmp/summary.md" },
    );
    expect(await main(h.deps)).toBe(1);
    expect(h.out()).toContain("::error title=Pluswithai · a.spec.ts failed::Error: boom");
    expect(h.files["/tmp/summary.md"]).toContain("| `a.spec.ts` | ❌ failed |");
    expect(h.files["junit.xml"]).toContain('failures="1"');
    expect(h.err()).toContain("JUnit report written to junit.xml");
  });

  it("--no-summary skips the step summary; outside Actions there are no annotations", async () => {
    const h = harness(["run", "-p", "shop", "--no-summary"], { script: { "a.spec.ts": ["failed"] } }, { GITHUB_STEP_SUMMARY: "/tmp/s.md" });
    expect(await main(h.deps)).toBe(1);
    expect(h.files["/tmp/s.md"]).toBeUndefined();
    expect(h.out()).not.toContain("::error");
  });

  it("--json prints one document on stdout", async () => {
    const h = harness(["run", "-p", "shop", "--json"], { script: { "a.spec.ts": ["passed"] } });
    expect(await main(h.deps)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ project: "shop", passed: true, exitCode: 0 });
  });

  it("times out with exit 4", async () => {
    const h = harness(["run", "-p", "shop", "--timeout", "10", "--interval", "5"], { script: { "a.spec.ts": ["running"] } });
    expect(await main(h.deps)).toBe(4);
    expect(h.out()).toContain("Timed out waiting for 1 run");
  });

  it("no test files exits 2", async () => {
    const h = harness(["run", "-p", "shop"], { files: [] });
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain("no test files");
  });

  it("--env and --base-url reach the API", async () => {
    const h = harness(["run", "-p", "shop", "-t", "a.spec.ts", "--env", "staging"]);
    expect(await main(h.deps)).toBe(0);
    const post = h.fetchFn.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ tests: ["a.spec.ts"], environment: "staging" });
  });

  it("prints retry notices on stderr", async () => {
    let first = true;
    const h = harness(["run", "-p", "shop", "-t", "a.spec.ts"], {
      route: (m) => {
        if (m === "POST" && first) {
          first = false;
          return json({ error: "Too many requests", retryAfterSeconds: 1 }, 429);
        }
        return undefined;
      },
    });
    expect(await main(h.deps)).toBe(0);
    expect(h.err()).toContain("retrying in 1s");
  });

  it("a JUnit or summary write failure is a warning, not a different exit code", async () => {
    const h = harness(["run", "-p", "shop", "--junit", "/nope/junit.xml"], { script: { "a.spec.ts": ["passed"] } }, { GITHUB_STEP_SUMMARY: "/nope/s.md" });
    h.deps.writeFile = async () => { throw new Error("EACCES"); };
    h.deps.appendFile = async () => { throw "EROFS"; };
    expect(await main(h.deps)).toBe(0);
    expect(h.err()).toContain("warning: could not write the JUnit report to /nope/junit.xml: EACCES");
    expect(h.err()).toContain("warning: could not write the GitHub step summary: EROFS");
  });
});

describe("main — mcp", () => {
  it("proxies stdin lines to /mcp and writes the answers to stdout, logging only to stderr", async () => {
    const h = harness(["mcp"]);
    h.deps.stdinLines = async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      yield JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    };
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toBe('{"jsonrpc":"2.0","id":1,"result":{"echoed":"tools/list"}}\n');
    expect(h.err()).toContain("Pluswithai MCP proxy → https://api.pluswithai.com/mcp");
    expect(String(h.fetchFn.mock.calls[0]![0])).toBe("https://api.pluswithai.com/mcp");
  });

  it("logs a failed notification to stderr (it has no id to answer)", async () => {
    const h = harness(["mcp"], { route: (_m, p) => (p === "/mcp" ? json({ error: "boom" }, 500) : undefined) });
    h.deps.stdinLines = async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    };
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toBe("");
    expect(h.err()).toContain("Pluswithai: 500 boom");
  });

  it("needs a key like every other command", async () => {
    const h = harness(["mcp"], {}, { PLUSWITHAI_API_KEY: undefined });
    expect(await main(h.deps)).toBe(2);
  });
});

describe("main — pull and local (a local run)", () => {
  it("pull writes the project's files under pluswithai/<project> and says how to run them", async () => {
    const h = harness(["pull", "-p", "shop"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.disk["pluswithai/shop/tests/checkout.spec.ts"]).toBe("test('x', () => {});\n");
    expect(h.out()).toContain("Pulled 2 files into pluswithai/shop.");
    expect(h.out()).toContain("npx playwright test");
  });

  it("pull --json, to another folder; a removed file and an unsafe path are reported", async () => {
    const h = harness(["pull", "-p", "shop", "--dir", "x", "--json"], {
      route: (_m, path) =>
        path === "/projects/shop/export"
          ? json({ headOid: "h", files: [{ path: "../evil", base64: "", size: 0 }, { path: "a.ts", base64: "", size: 0 }] })
          : undefined,
    });
    h.disk["x/.pluswithai/pulled.json"] = JSON.stringify(["old.ts"]);
    h.disk["x/old.ts"] = "o";
    expect(await main(h.deps)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ dir: "x", written: 1, removed: 1, skipped: ["../evil"] });
    expect(h.err()).toContain("skipped 1 file(s) with unsafe paths: ../evil");
    const plain = harness(["pull", "-p", "shop", "--dir", "x"]);
    plain.disk["x/.pluswithai/pulled.json"] = JSON.stringify(["old.ts"]);
    expect(await main(plain.deps)).toBe(0);
    expect(plain.out()).toContain("(removed 1 the project no longer has)");
  });

  it("local pulls, installs, runs Playwright against the base URL and exits with its verdict", async () => {
    const h = harness(["local", "-p", "shop", "-t", "tests/checkout.spec.ts", "--base-url", "http://localhost:3000", "--headed"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.spawned.map((s) => `${s.command} ${s.args.join(" ")}`)).toEqual([
      "npm install --no-audit --no-fund",
      "npx playwright install chromium",
      "npx playwright test tests/checkout.spec.ts --headed",
    ]);
    expect(h.spawned[2]).toMatchObject({ cwd: "pluswithai/shop", env: { PLUSWITHAI_BASE_URL: "http://localhost:3000" } });
    const failing = harness(["local", "-p", "shop", "--dir", "w"], { spawn: (c, a) => (a[1] === "test" ? 1 : 0) });
    expect(await main(failing.deps)).toBe(1);
  });

  it("a setup problem exits 2 with the reason; a plan that cannot download gets the hint", async () => {
    const h = harness(["local", "-p", "shop", "--no-pull"]);
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain("has no project yet");
    const pro = harness(["pull", "-p", "shop"], { route: (_m, p) => (p === "/projects/shop/export" ? json({ error: "Pro feature" }, 402) : undefined) });
    expect(await main(pro.deps)).toBe(3);
    expect(pro.err()).toContain("Your plan cannot download");
    const proTest = harness(["local", "-p", "shop"], { route: (_m, p) => (p === "/projects/shop/export" ? json({ error: "Pro feature" }, 402) : undefined) });
    expect(await main(proTest.deps)).toBe(3);
    expect(proTest.err()).toContain("Your plan cannot download");
  });
});
