import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { nodeDeps } from "../src/node-deps.js";
import { VERSION } from "../src/version.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("nodeDeps — the real process wiring", () => {
  it("takes argv after the script and the environment", () => {
    const deps = nodeDeps({ argv: ["node", "pluswithai", "run", "-p", "x"], env: { A: "1" } });
    expect(deps.argv).toEqual(["run", "-p", "x"]);
    expect(deps.env).toEqual({ A: "1" });
  });

  it("calls the global fetch unbound (workerd and undici dislike a foreign `this`)", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", function (this: unknown) {
      seen.push(this);
      return Promise.resolve(new Response("ok"));
    });
    const deps = nodeDeps({ argv: [], env: {} });
    await deps.fetch("https://x.example");
    expect(seen[0]).toBeUndefined();
  });

  it("writes to stdout and stderr", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const deps = nodeDeps({ argv: [], env: {} });
    deps.stdout("a");
    deps.stderr("b");
    expect(out).toHaveBeenCalledWith("a");
    expect(err).toHaveBeenCalledWith("b");
  });

  it("sleeps and tells the time", async () => {
    const deps = nodeDeps({ argv: [], env: {} });
    const before = deps.now();
    await deps.sleep(5);
    expect(deps.now()).toBeGreaterThanOrEqual(before + 4);
  });

  it("reads stdin line by line", async () => {
    const deps = nodeDeps({ argv: [], env: {}, stdin: Readable.from(["a\nb", "\nc\n"]) });
    const lines: string[] = [];
    for await (const line of deps.stdinLines()) lines.push(line);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("defaults to the process's stdin", () => {
    expect(() => nodeDeps({ argv: [], env: {} }).stdinLines()).not.toThrow();
  });

  it("writes and appends files, creating the folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pluswithai-cli-"));
    const deps = nodeDeps({ argv: [], env: {} });
    const file = join(dir, "nested", "out.txt");
    await deps.writeFile(file, "a");
    await deps.appendFile(file, "b");
    expect(readFileSync(file, "utf8")).toBe("ab");
  });
});

describe("bin", () => {
  it("runs main with the real process and sets the exit code", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const argv = process.argv;
    process.argv = ["node", "pluswithai", "--version"];
    try {
      await import("../src/bin.js");
    } finally {
      process.argv = argv;
    }
    expect(out).toHaveBeenCalledWith(`${VERSION}\n`);
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });
});

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
