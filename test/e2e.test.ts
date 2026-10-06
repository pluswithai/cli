/**
 * The built CLI (dist/bin.js, from `npm run build`) as a real child process
 * against a local HTTP server that speaks the Pluswithai API. Catches what
 * unit tests with injected fakes cannot: the shebang, ESM resolution of the
 * compiled output, real fetch, real exit codes, real files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const KEY = "pwai_e2eKeyE2eKeyE2eKeyE2eKeyE2eKeyE2eKey123";

let server: Server;
let api = "";
const polls: Record<string, number> = {};
const seenAuth: string[] = [];

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error("dist/bin.js missing — run `npm run build` (npm test does it for you)");
  server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? "");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "Invalid or revoked API key" });
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/mcp" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const msg = JSON.parse(raw) as { id?: number; method: string };
        if (msg.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        const result = msg.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pluswithai", version: "1.0.0" } }
          : { tools: [{ name: "list_projects", inputSchema: { type: "object" } }], sawVersion: req.headers["mcp-protocol-version"] ?? null };
        send(200, { jsonrpc: "2.0", id: msg.id, result });
      });
      return;
    }
    if (url.pathname === "/projects/shop/test-files") return send(200, { files: ["tests/ok.spec.ts", "tests/bad.spec.ts"] });
    if (url.pathname === "/projects/shop/run-tests" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { tests } = JSON.parse(body) as { tests: string[] };
        send(202, {
          async: true,
          results: tests.map((t) => ({ id: `run-${t}`, project: "u::shop", testFiles: [t], status: "queued", exitCode: 0, stdout: "", stderr: "", duration: 0, timestamp: 1, scheduled: false })),
        });
      });
      return;
    }
    const m = url.pathname.match(/^\/projects\/shop\/runs\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      polls[id] = (polls[id] ?? 0) + 1;
      const file = id.replace(/^run-/, "");
      const done = polls[id]! >= 2;
      const status = !done ? "running" : file.includes("bad") ? "failed" : "passed";
      return send(200, {
        run: { id, project: "u::shop", testFiles: [file], status, exitCode: status === "failed" ? 1 : 0, stdout: status === "failed" ? "Error: expected true" : "", stderr: "", duration: 1500, timestamp: 1, scheduled: false },
        artifacts: [],
      });
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  api = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function cli(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { PATH: process.env.PATH ?? "", PLUSWITHAI_API_KEY: KEY, PLUSWITHAI_API_URL: api, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
  });
}

function mcpSession(lines: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, "mcp"],
      { env: { PATH: process.env.PATH ?? "", PLUSWITHAI_API_KEY: KEY, PLUSWITHAI_API_URL: api } },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
    // One message per line, sequentially, then EOF — like a client that hangs up.
    (async () => {
      for (const line of lines) {
        child.stdin!.write(`${line}\n`);
        await new Promise((r) => setTimeout(r, 150));
      }
      child.stdin!.end();
    })();
  });
}

describe("dist/bin.js end to end", () => {
  it("mcp: a stdio session — initialize, initialized, tools/list — then exits 0 on EOF", async () => {
    const r = await mcpSession([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ]);
    expect(r.code).toBe(0);
    const messages = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
    expect(messages[0].result.serverInfo.name).toBe("pluswithai");
    expect(messages[1].result.tools[0].name).toBe("list_projects");
    // The negotiated version is sent on every request after initialize.
    expect(messages[1].result.sawVersion).toBe("2025-06-18");
    expect(r.stderr).toContain("Pluswithai MCP proxy");
  });

  it("--version", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(await cli(["--version"])).toMatchObject({ code: 0, stdout: `${pkg.version}\n` });
  });

  it("a full run: progress, summary, JUnit, step summary, annotations, exit 1 on the failed file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pluswithai-e2e-"));
    const junit = join(dir, "junit.xml");
    const summary = join(dir, "summary.md");
    const r = await cli(["run", "--project", "shop", "--interval", "0.05", "--junit", junit], {
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Started 2 runs in shop");
    expect(r.stderr).toContain("✓ tests/ok.spec.ts  passed  1.5s");
    expect(r.stderr).toContain("✗ tests/bad.spec.ts  failed  1.5s");
    expect(r.stdout).toContain("1 passed, 1 failed");
    expect(r.stdout).toContain("::error title=Pluswithai · tests/bad.spec.ts failed::Error: expected true");
    expect(readFileSync(junit, "utf8")).toContain('tests="2" failures="1"');
    expect(readFileSync(summary, "utf8")).toContain("| `tests/ok.spec.ts` | ✅ passed | 1.5s |");
    expect(seenAuth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
  });

  it("a wrong key: exit 3, hint, key not echoed", async () => {
    const wrong = "pwai_wrongWrongWrongWrongWrongWrongWrong12";
    const r = await cli(["projects"], { PLUSWITHAI_API_KEY: wrong });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("401 Invalid or revoked API key");
    expect(r.stderr + r.stdout).not.toContain(wrong);
  });

  it("no key: exit 2 without a request", async () => {
    const before = seenAuth.length;
    const r = await cli(["projects"], { PLUSWITHAI_API_KEY: "" });
    expect(r.code).toBe(2);
    expect(seenAuth.length).toBe(before);
  });
});
