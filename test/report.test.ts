import { describe, expect, it } from "vitest";
import {
  annotations,
  appLink,
  formatDuration,
  junitXml,
  markdownSummary,
  progressLine,
  projectsText,
  runJson,
  runsText,
  startedLine,
  summaryText,
  table,
  testsText,
  whoamiText,
} from "../src/report.js";
import type { RunOutcome } from "../src/run.js";
import { run } from "./fixtures.js";

const APP = "https://pluswithai.com";

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  results: [
    run({ id: "r1", testFiles: ["tests/a.spec.ts"], status: "passed", duration: 12_300 }),
    run({
      id: "r2",
      testFiles: ["tests/b.spec.ts"],
      status: "failed",
      duration: 65_000,
      stdout: "\n  1) b.spec.ts:3 › checkout\n    Error: expect(locator).toBeVisible() <failed>\n",
    }),
    run({ id: "r3", testFiles: ["tests/c.spec.ts"], status: "error", duration: 0, stderr: "runner crashed & burned" }),
  ],
  pending: [],
  timedOut: false,
  exitCode: 1,
  ...over,
});

describe("formatDuration", () => {
  it.each([
    [0, "0.0s"],
    [12_345, "12.3s"],
    [65_000, "1m 5s"],
    [3_600_000, "60m 0s"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("appLink", () => {
  it("links to the project in the app", () => {
    expect(appLink(APP, "my shop")).toBe("https://pluswithai.com/app?project=my%20shop");
  });
});

describe("progress lines", () => {
  it("one line per finished run, with a symbol per status", () => {
    const [a, b, c] = outcome().results;
    expect(progressLine(a!)).toBe("✓ tests/a.spec.ts  passed  12.3s");
    expect(progressLine(b!)).toBe("✗ tests/b.spec.ts  failed  1m 5s");
    expect(progressLine(c!)).toBe("! tests/c.spec.ts  error  0.0s");
  });

  it("has a symbol for every status, pending ones included", () => {
    expect(progressLine(run({ status: "queued" }))).toBe("· tests/a.spec.ts  queued  1.0s");
    expect(progressLine(run({ status: "running" }))).toBe("· tests/a.spec.ts  running  1.0s");
  });

  it("marks a run cut off by the time limit", () => {
    expect(progressLine(run({ status: "failed", timedOut: true }))).toContain("failed (timed out)");
  });

  it("announces how many runs started", () => {
    expect(startedLine("shop", 1)).toBe("Started 1 run in shop. Waiting for results…");
    expect(startedLine("shop", 3)).toBe("Started 3 runs in shop. Waiting for results…");
  });
});

describe("summaryText", () => {
  it("counts, lists and links", () => {
    const text = summaryText(outcome(), "shop", APP);
    expect(text).toContain("1 passed, 1 failed, 1 error");
    expect(text).toContain("tests/b.spec.ts");
    expect(text).toContain("https://pluswithai.com/app?project=shop");
  });

  it("names what was still running at the timeout", () => {
    const text = summaryText(
      outcome({ results: [], pending: [run({ testFiles: ["tests/slow.spec.ts"], status: "running" })], timedOut: true, exitCode: 4 }),
      "shop",
      APP,
    );
    expect(text).toContain("0 passed");
    expect(text).toContain("Timed out waiting for 1 run: tests/slow.spec.ts");
  });

  it("pluralises the pending count", () => {
    const text = summaryText(
      outcome({ results: [], pending: [run({ testFiles: ["a.spec.ts"] }), run({ testFiles: ["b.spec.ts"] })], timedOut: true, exitCode: 4 }),
      "shop",
      APP,
    );
    expect(text).toContain("Timed out waiting for 2 runs: a.spec.ts, b.spec.ts");
  });

  it("is short when everything passed", () => {
    const text = summaryText(outcome({ results: [run()], exitCode: 0 }), "shop", APP);
    expect(text).toContain("1 passed");
    expect(text).not.toContain("failed");
  });
});

describe("markdownSummary", () => {
  it("is a GitHub-flavoured table with a status line and the app link", () => {
    const md = markdownSummary(outcome(), "shop", APP);
    expect(md).toContain("### ❌ Pluswithai · shop");
    expect(md).toContain("| Test | Status | Duration |");
    expect(md).toContain("| `tests/a.spec.ts` | ✅ passed | 12.3s |");
    expect(md).toContain("| `tests/b.spec.ts` | ❌ failed | 1m 5s |");
    expect(md).toContain("| `tests/c.spec.ts` | ⚠️ error | 0.0s |");
    expect(md).toContain("[Open in Pluswithai](https://pluswithai.com/app?project=shop)");
  });

  it("marks success and pending runs", () => {
    expect(markdownSummary(outcome({ results: [run()], exitCode: 0 }), "shop", APP)).toContain("### ✅ Pluswithai · shop");
    const timedOut = markdownSummary(
      outcome({ results: [], pending: [run({ testFiles: ["s.spec.ts"], status: "running" })], timedOut: true, exitCode: 4 }),
      "shop",
      APP,
    );
    expect(timedOut).toContain("### ⏱️ Pluswithai · shop");
    expect(timedOut).toContain("| `s.spec.ts` | ⏱️ still running | — |");
  });

  it("escapes pipes in file names so the table holds", () => {
    expect(markdownSummary(outcome({ results: [run({ testFiles: ["a|b.spec.ts"] })], exitCode: 0 }), "shop", APP)).toContain("a\\|b.spec.ts");
  });
});

describe("annotations", () => {
  it("one ::error per failed or errored run, none for passes", () => {
    const lines = annotations(outcome());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("::error title=Pluswithai · tests/b.spec.ts failed::1) b.spec.ts:3 › checkout%0A    Error: expect(locator).toBeVisible() <failed>");
    expect(lines[1]).toBe("::error title=Pluswithai · tests/c.spec.ts error::runner crashed & burned");
  });

  it("falls back to a generic message and escapes % and newlines", () => {
    const [line] = annotations(outcome({ results: [run({ status: "failed", stdout: "", stderr: "" })] }));
    expect(line).toBe("::error title=Pluswithai · tests/a.spec.ts failed::The run failed. Open it in Pluswithai for the video and trace.");
    const [pct] = annotations(outcome({ results: [run({ status: "failed", stderr: "100% broken\r\nnext" })] }));
    expect(pct).toContain("100%25 broken%0D%0Anext");
  });
});

describe("junitXml", () => {
  it("one testcase per run, failures and errors with their output, XML-escaped", () => {
    const xml = junitXml(outcome(), "shop");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<testsuite name="Pluswithai · shop" tests="3" failures="1" errors="1" skipped="0" time="77.300">');
    expect(xml).toContain('<testcase name="tests/a.spec.ts" classname="shop" time="12.300"/>');
    expect(xml).toContain('<failure message="failed">');
    expect(xml).toContain("&lt;failed&gt;");
    expect(xml).toContain('<error message="error">runner crashed &amp; burned</error>');
  });

  it("reports pending runs as skipped at a timeout", () => {
    const xml = junitXml(outcome({ results: [], pending: [run({ testFiles: ['q"uote.spec.ts'], status: "running" })], timedOut: true }), "shop");
    expect(xml).toContain('tests="1" failures="0" errors="0" skipped="1"');
    expect(xml).toContain('<testcase name="q&quot;uote.spec.ts" classname="shop" time="0.000"><skipped message="Timed out waiting for the result"/></testcase>');
  });

  it("keeps only the tail of very long output", () => {
    const xml = junitXml(outcome({ results: [run({ status: "failed", stdout: "x".repeat(20_000) })] }), "shop");
    expect(xml.length).toBeLessThan(10_000);
  });
});

describe("runJson", () => {
  it("is a stable document for scripts", () => {
    const doc = runJson(outcome(), "shop", APP);
    expect(doc).toEqual({
      project: "shop",
      url: "https://pluswithai.com/app?project=shop",
      passed: false,
      exitCode: 1,
      timedOut: false,
      environment: "production",
      baseUrl: null,
      counts: { passed: 1, failed: 1, error: 1, pending: 0 },
      results: [
        { id: "r1", file: "tests/a.spec.ts", status: "passed", durationMs: 12_300, timedOut: false },
        { id: "r2", file: "tests/b.spec.ts", status: "failed", durationMs: 65_000, timedOut: false },
        { id: "r3", file: "tests/c.spec.ts", status: "error", durationMs: 0, timedOut: false },
      ],
      pending: [],
    });
  });

  it("lists pending runs", () => {
    const doc = runJson(outcome({ results: [], pending: [run({ id: "p", status: "running" })], timedOut: true, exitCode: 4 }), "shop", APP);
    expect(doc.pending).toEqual([{ id: "p", file: "tests/a.spec.ts", status: "running" }]);
  });
});

describe("tables for read commands", () => {
  it("aligns columns", () => {
    expect(table([["NAME", "URL"], ["shop", "https://shop.example"], ["blog-site", "-"]])).toBe(
      "NAME       URL\nshop       https://shop.example\nblog-site  -",
    );
  });

  it("projects", () => {
    expect(projectsText([])).toBe("No projects yet. Create one at https://pluswithai.com/app");
    expect(projectsText([{ name: "shop", url: "https://shop.example", createdAt: "2026-01-02T03:04:05Z", displayName: "Shop" }])).toBe(
      "NAME  TITLE  URL                   CREATED\nshop  Shop   https://shop.example  2026-01-02",
    );
    expect(projectsText([{ name: "x", url: "u", createdAt: "" }])).toContain("x     -      u    -");
  });

  it("tests", () => {
    expect(testsText("shop", [])).toBe("No test files in shop.");
    expect(testsText("shop", ["tests/a.spec.ts", "tests/b.spec.ts"])).toBe("tests/a.spec.ts\ntests/b.spec.ts");
  });

  it("runs", () => {
    expect(runsText("shop", [])).toBe("No runs yet in shop.");
    const text = runsText("shop", [
      run({ id: "r1", status: "failed", duration: 65_000, timestamp: Date.UTC(2026, 9, 5, 12, 30), scheduled: true }),
      run({ id: "r2", testFiles: ["a.spec.ts", "b.spec.ts"], timestamp: Date.UTC(2026, 9, 5, 12, 0) }),
    ]);
    expect(text).toBe(
      [
        "ID  STATUS  TESTS            DURATION  TRIGGER    STARTED",
        "r1  failed  tests/a.spec.ts  1m 5s     scheduled  2026-10-05 12:30Z",
        "r2  passed  2 files          1.0s      manual     2026-10-05 12:00Z",
      ].join("\n"),
    );
  });

  it("whoami", () => {
    expect(whoamiText({ userId: "u1", email: null }, "https://api.pluswithai.com")).toBe(
      "Authenticated with an API key as account u1\nAPI: https://api.pluswithai.com",
    );
    expect(whoamiText({ userId: "u1", email: "a@b.c" }, "https://x")).toContain("account u1 (a@b.c)");
  });
});

describe("annotation properties", () => {
  it("escapes characters GitHub treats as separators in the title", () => {
    const [line] = annotations({ results: [run({ status: "failed", testFiles: ["a,b:c.spec.ts"], stdout: "x" })], pending: [], timedOut: false, exitCode: 1 });
    expect(line).toBe("::error title=Pluswithai · a%2Cb%3Ac.spec.ts failed::x");
  });
});

describe("annotation message from real Playwright output", () => {
  it("is the failure block, not the run banner or the attachments", async () => {
    const { PLAYWRIGHT_FAILURE } = await import("./playwright-failure.js");
    const [line] = annotations({ results: [run({ status: "failed", stdout: PLAYWRIGHT_FAILURE })], pending: [], timedOut: false, exitCode: 1 });
    const message = line!.split("::").slice(2).join("::");
    expect(message.startsWith("1) tests/mcp-heading.spec.ts:3:5")).toBe(true);
    expect(message).toContain("Error: expect(locator).toBeVisible() failed");
    expect(message).not.toContain("Running 1 test");
    expect(message).not.toContain("attachment #");
  });
});

describe("annotation message without a Playwright failure block", () => {
  it("starts at the first Error: line", () => {
    const [line] = annotations({ results: [run({ status: "error", stdout: "warming up\nTypeError: x is undefined\n  at y" })], pending: [], timedOut: false, exitCode: 3 });
    expect(line).toContain("::TypeError: x is undefined%0A  at y");
  });
});

describe("environment in reports (ENVIRONMENTS_SPEC.md §5)", () => {
  const withEnv = (): RunOutcome => ({
    results: [run({ status: "passed", environment: "preview", baseUrl: "https://shop-git-x.vercel.app" })],
    pending: [],
    timedOut: false,
    exitCode: 0,
  });

  it("the text summary and the step summary name the environment and its URL", () => {
    expect(summaryText(withEnv(), "shop", APP)).toContain("Pluswithai · shop (preview: https://shop-git-x.vercel.app): 1 passed");
    expect(markdownSummary(withEnv(), "shop", APP)).toContain("### ✅ Pluswithai · shop · preview");
    expect(markdownSummary(withEnv(), "shop", APP)).toContain("Ran against https://shop-git-x.vercel.app");
  });

  it("JUnit and --json carry it too", () => {
    expect(junitXml(withEnv(), "shop")).toContain('name="Pluswithai · shop · preview"');
    expect(runJson(withEnv(), "shop", APP)).toMatchObject({ environment: "preview", baseUrl: "https://shop-git-x.vercel.app" });
  });

  it("nothing changes for a run against the project URL", () => {
    const plain = outcome({ results: [run()], exitCode: 0 });
    expect(summaryText(plain, "shop", APP)).toContain("Pluswithai · shop: 1 passed");
    expect(markdownSummary(plain, "shop", APP)).not.toContain("Ran against");
    expect(runJson(plain, "shop", APP)).toMatchObject({ environment: "production", baseUrl: null });
  });
});
