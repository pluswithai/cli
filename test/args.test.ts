import { describe, expect, it } from "vitest";
import { helpText, parseCommand, UsageError } from "../src/args.js";

describe("parseCommand — top level", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])("%j → general help", (argv) => {
    expect(parseCommand(argv)).toEqual({ kind: "help" });
  });

  it.each([[["--version"]], [["-v"]]])("%j → version", (argv) => {
    expect(parseCommand(argv)).toEqual({ kind: "version" });
  });

  it("help <command> → that command's help", () => {
    expect(parseCommand(["help", "run"])).toEqual({ kind: "help", topic: "run" });
  });

  it("<command> --help → that command's help, even with missing required flags", () => {
    expect(parseCommand(["run", "--help"])).toEqual({ kind: "help", topic: "run" });
    expect(parseCommand(["runs", "-h"])).toEqual({ kind: "help", topic: "runs" });
  });

  it("rejects an unknown command, naming it", () => {
    expect(() => parseCommand(["deploy"])).toThrow(new UsageError('Unknown command "deploy". Run pluswithai --help.'));
  });

  it("rejects help for an unknown topic", () => {
    expect(() => parseCommand(["help", "deploy"])).toThrow(UsageError);
  });
});

describe("parseCommand — run", () => {
  it("applies the defaults", () => {
    expect(parseCommand(["run", "--project", "shop"])).toEqual({
      kind: "run",
      global: {},
      project: "shop",
      tests: [],
      region: undefined,
      timeoutSec: 1800,
      intervalSec: 5,
      junit: undefined,
      json: false,
      summary: true,
    });
  });

  it("reads every flag, repeated --test included", () => {
    expect(
      parseCommand([
        "run", "-p", "shop", "--test", "a.spec.ts", "-t", "b.spec.ts", "--region", "weur",
        "--timeout", "600", "--interval", "2", "--junit", "out/junit.xml", "--json", "--no-summary",
        "--api-url", "http://localhost:8787", "--app-url", "http://localhost:3000",
      ]),
    ).toEqual({
      kind: "run",
      global: { apiUrl: "http://localhost:8787", appUrl: "http://localhost:3000" },
      project: "shop",
      tests: ["a.spec.ts", "b.spec.ts"],
      region: "weur",
      timeoutSec: 600,
      intervalSec: 2,
      junit: "out/junit.xml",
      json: true,
      summary: false,
    });
  });

  it("requires --project", () => {
    expect(() => parseCommand(["run"])).toThrow(new UsageError("Missing --project <name>.", "run"));
  });

  it.each([
    [["--timeout", "0"], "--timeout must be a positive number of seconds."],
    [["--timeout", "abc"], "--timeout must be a positive number of seconds."],
    [["--interval=-1"], "--interval must be a positive number of seconds."],
  ])("validates numbers %j", (extra, message) => {
    expect(() => parseCommand(["run", "--project", "shop", ...extra])).toThrow(new UsageError(message, "run"));
  });

  it("a dash-led value without = is still a usage error (parseArgs calls it ambiguous)", () => {
    expect(() => parseCommand(["run", "--project", "shop", "--interval", "-1"])).toThrow(UsageError);
  });

  it("rejects unknown flags and stray positionals", () => {
    expect(() => parseCommand(["run", "--project", "shop", "--bogus"])).toThrow(UsageError);
    expect(() => parseCommand(["run", "--project", "shop", "extra"])).toThrow(UsageError);
  });

  it("refuses --api-key: keys come from the environment only", () => {
    expect(() => parseCommand(["run", "--project", "shop", "--api-key", "pwai_x"])).toThrow(
      /PLUSWITHAI_API_KEY/,
    );
  });
});

describe("parseCommand — read commands", () => {
  it("projects", () => {
    expect(parseCommand(["projects"])).toEqual({ kind: "projects", global: {}, json: false });
    expect(parseCommand(["projects", "--json"])).toEqual({ kind: "projects", global: {}, json: true });
  });

  it("tests requires --project", () => {
    expect(parseCommand(["tests", "--project", "shop"])).toEqual({ kind: "tests", global: {}, project: "shop", json: false });
    expect(() => parseCommand(["tests"])).toThrow(UsageError);
  });

  it("runs: --limit defaults to 10 and must be 1–100", () => {
    expect(parseCommand(["runs", "--project", "shop"])).toEqual({
      kind: "runs", global: {}, project: "shop", limit: 10, json: false,
    });
    expect(parseCommand(["runs", "-p", "shop", "--limit", "25", "--json"])).toMatchObject({ limit: 25, json: true });
    expect(() => parseCommand(["runs", "-p", "shop", "--limit", "0"])).toThrow(UsageError);
    expect(() => parseCommand(["runs", "-p", "shop", "--limit", "101"])).toThrow(UsageError);
    expect(() => parseCommand(["runs", "-p", "shop", "--limit", "2.5"])).toThrow(UsageError);
    expect(() => parseCommand(["runs"])).toThrow(UsageError);
  });

  it("mcp takes only the global options", () => {
    expect(parseCommand(["mcp"])).toEqual({ kind: "mcp", global: {} });
    expect(parseCommand(["mcp", "--api-url", "http://localhost:8787"])).toEqual({ kind: "mcp", global: { apiUrl: "http://localhost:8787" } });
    expect(parseCommand(["mcp", "--help"])).toEqual({ kind: "help", topic: "mcp" });
    expect(() => parseCommand(["mcp", "--project", "x"])).toThrow(UsageError);
  });

  it("whoami", () => {
    expect(parseCommand(["whoami", "--api-url", "https://x.example"])).toEqual({
      kind: "whoami", global: { apiUrl: "https://x.example" }, json: false,
    });
  });
});

describe("helpText", () => {
  it("lists every command in the general help", () => {
    const text = helpText();
    for (const cmd of ["run", "projects", "tests", "runs", "whoami", "mcp"]) expect(text).toContain(cmd);
    expect(text).toContain("PLUSWITHAI_API_KEY");
  });

  it("documents each command's flags and exit codes for run", () => {
    expect(helpText("run")).toContain("--junit");
    expect(helpText("run")).toMatch(/Exit codes/);
    expect(helpText("runs")).toContain("--limit");
    expect(helpText("tests")).toContain("--project");
    expect(helpText("projects")).toContain("--json");
    expect(helpText("whoami")).toContain("--json");
    expect(helpText("mcp")).toMatch(/stdio/);
  });
});
