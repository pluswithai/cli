import { describe, expect, it, vi } from "vitest";
import { defaultDir, LocalSetupError, MANIFEST, playwrightArgs, pullProject, safeRelativePath, testLocally, type LocalDeps } from "../src/local.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");

function fakeDeps(disk: Record<string, string> = {}, spawnCode: (command: string, args: string[]) => number | Error = () => 0) {
  const logs: string[] = [];
  const spawned: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
  const deps: LocalDeps = {
    readText: async (p) => disk[p] ?? null,
    writeBytes: async (p, bytes) => { disk[p] = new TextDecoder().decode(bytes); },
    remove: async (p) => { delete disk[p]; },
    exists: async (p) => p in disk || Object.keys(disk).some((k) => k.startsWith(`${p}/`)),
    spawn: async (command, args, opts) => {
      spawned.push({ command, args, env: opts.env });
      const code = spawnCode(command, args);
      if (code instanceof Error) throw code;
      return code;
    },
    log: (t) => logs.push(t),
  };
  return { deps, disk, logs, spawned };
}

const client = (files: Array<{ path: string; text: string }>) => ({
  exportFiles: vi.fn(async () => ({ headOid: "h1", files: files.map((f) => ({ path: f.path, base64: b64(f.text), size: f.text.length })) })),
});

describe("paths", () => {
  it("keeps plain relative paths and refuses anything that could leave the folder", () => {
    expect(safeRelativePath("tests/a.spec.ts")).toBe("tests/a.spec.ts");
    expect(safeRelativePath("/vitals.ts")).toBe("vitals.ts");
    for (const bad of ["", "../x", "tests/../../x", "a//b", "./a", "a\\\\b", "a\u0000b", "/"]) expect(safeRelativePath(bad)).toBeNull();
  });

  it("a default folder per project", () => {
    expect(defaultDir("shop")).toBe("pluswithai/shop");
    expect(defaultDir("my shop/../x")).toBe("pluswithai/my-shop-..-x");
  });
});

describe("pullProject", () => {
  it("writes the files, records them, and removes what the project dropped", async () => {
    const { deps, disk } = fakeDeps({
      [`out/${MANIFEST}`]: JSON.stringify(["tests/old.spec.ts", "tests/a.spec.ts", "../evil", 7]),
      "out/tests/old.spec.ts": "old",
    });
    const r = await pullProject(deps, client([{ path: "tests/a.spec.ts", text: "A" }, { path: "../x", text: "no" }, { path: MANIFEST, text: "no" }]), "shop", "out/");
    expect(r).toEqual({ dir: "out/", written: 1, removed: 1, skipped: ["../x", MANIFEST], headOid: "h1" });
    expect(disk["out/tests/a.spec.ts"]).toBe("A");
    expect(disk["out/tests/old.spec.ts"]).toBeUndefined();
    expect(JSON.parse(disk[`out/${MANIFEST}`]!)).toEqual(["tests/a.spec.ts"]);
  });

  it("a manifest it cannot read removes nothing", async () => {
    for (const manifest of ["not json", JSON.stringify({ a: 1 })]) {
      const { deps, disk } = fakeDeps({ [`out/${MANIFEST}`]: manifest, "out/keep.txt": "k" });
      const r = await pullProject(deps, client([{ path: "a.ts", text: "a" }]), "shop", "out");
      expect(r.removed).toBe(0);
      expect(disk["out/keep.txt"]).toBe("k");
    }
  });
});

describe("testLocally", () => {
  const base = { project: "shop", dir: "out", tests: [] as string[], headed: false, pull: true, env: { PATH: "/bin" } };

  it("pulls, installs the first time, then runs Playwright with the base URL", async () => {
    const { deps, spawned, logs } = fakeDeps();
    const code = await testLocally(deps, client([{ path: "playwright.config.ts", text: "x" }]), { ...base, tests: ["tests/a.spec.ts"], headed: true, baseUrl: "http://localhost:3000" });
    expect(code).toBe(0);
    expect(spawned.map((s) => [s.command, ...s.args].join(" "))).toEqual([
      "npm install --no-audit --no-fund",
      "npx playwright install chromium",
      "npx playwright test tests/a.spec.ts --headed",
    ]);
    expect(spawned[2]!.env).toEqual({ PATH: "/bin", PLUSWITHAI_BASE_URL: "http://localhost:3000" });
    expect(logs[0]).toMatch(/Pulled 1 files into out\./);
  });

  it("skips the install once node_modules is there, and reports a failing run as 1", async () => {
    const { deps, spawned } = fakeDeps({ "out/node_modules/.package-lock.json": "{}", [`out/${MANIFEST}`]: JSON.stringify(["gone.ts"]), "out/gone.ts": "g" }, () => 1);
    expect(await testLocally(deps, client([{ path: "playwright.config.ts", text: "x" }]), base)).toBe(1);
    expect(spawned.map((s) => s.args.join(" "))).toEqual(["playwright test"]);
    expect(spawned[0]!.env).toEqual({ PATH: "/bin" });
  });

  it("--no-pull needs a project already in the folder", async () => {
    const { deps } = fakeDeps();
    await expect(testLocally(deps, client([]), { ...base, pull: false })).rejects.toThrow(LocalSetupError);
    const ready = fakeDeps({ "out/playwright.config.ts": "x", "out/node_modules/x": "" });
    expect(await testLocally(ready.deps, client([]), { ...base, pull: false })).toBe(0);
  });

  it("explains a setup that fails: npm missing, an install that exits non-zero, npx missing", async () => {
    const noNpm = fakeDeps({}, () => new Error("spawn npm ENOENT"));
    await expect(testLocally(noNpm.deps, client([]), base)).rejects.toThrow(/Could not start npm: spawn npm ENOENT/);
    const badInstall = fakeDeps({}, (c) => (c === "npm" ? 1 : 0));
    await expect(testLocally(badInstall.deps, client([]), base)).rejects.toThrow(/npm install --no-audit --no-fund exited with 1/);
    const noNpx = fakeDeps({ "out/node_modules/x": "" }, () => new Error("ENOENT"));
    await expect(testLocally(noNpx.deps, client([]), base)).rejects.toThrow(/Could not start npx: ENOENT/);
    const odd = fakeDeps({}, () => { throw "boom"; });
    await expect(testLocally(odd.deps, client([]), base)).rejects.toThrow(/Could not start npm: boom/);
    const oddRun = fakeDeps({ "out/node_modules/x": "" }, () => { throw "gone"; });
    await expect(testLocally(oddRun.deps, client([]), base)).rejects.toThrow(/Could not start npx: gone/);
  });

  it("builds Playwright's arguments", () => {
    expect(playwrightArgs([], false)).toEqual(["playwright", "test"]);
    expect(playwrightArgs(["a", "b"], true)).toEqual(["playwright", "test", "a", "b", "--headed"]);
  });
});
