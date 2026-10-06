import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_API_URL, DEFAULT_APP_URL, redact, resolveConfig } from "../src/config.js";

const KEY = "pwai_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

describe("resolveConfig", () => {
  it("uses the defaults with only a key", () => {
    expect(resolveConfig({}, { PLUSWITHAI_API_KEY: KEY })).toEqual({
      apiKey: KEY,
      apiUrl: DEFAULT_API_URL,
      appUrl: DEFAULT_APP_URL,
    });
    expect(DEFAULT_API_URL).toBe("https://api.pluswithai.com");
    expect(DEFAULT_APP_URL).toBe("https://pluswithai.com");
  });

  it("env beats defaults, flags beat env; trailing slashes go", () => {
    const env = { PLUSWITHAI_API_KEY: KEY, PLUSWITHAI_API_URL: "https://env-api.example/", PLUSWITHAI_APP_URL: "https://env-app.example" };
    expect(resolveConfig({}, env)).toMatchObject({ apiUrl: "https://env-api.example", appUrl: "https://env-app.example" });
    expect(resolveConfig({ apiUrl: "http://localhost:8787//", appUrl: "http://localhost:3000/" }, env)).toMatchObject({
      apiUrl: "http://localhost:8787",
      appUrl: "http://localhost:3000",
    });
  });

  it("trims the key (a pasted secret often carries a newline)", () => {
    expect(resolveConfig({}, { PLUSWITHAI_API_KEY: `  ${KEY}\n` }).apiKey).toBe(KEY);
  });

  it("explains a missing key and where to get one", () => {
    expect(() => resolveConfig({}, {})).toThrow(ConfigError);
    expect(() => resolveConfig({}, { PLUSWITHAI_API_KEY: "  " })).toThrow(/the app's API keys page/);
  });

  it("rejects something that is not a Pluswithai key, without echoing it", () => {
    let message = "";
    try {
      resolveConfig({}, { PLUSWITHAI_API_KEY: "ghp_secretvalue" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/pwai_/);
    expect(message).not.toContain("secretvalue");
  });

  it.each([["ftp://x.example"], ["not a url"]])("rejects a bad --api-url %s", (apiUrl) => {
    expect(() => resolveConfig({ apiUrl }, { PLUSWITHAI_API_KEY: KEY })).toThrow(/--api-url/);
  });

  it("rejects a bad --app-url", () => {
    expect(() => resolveConfig({ appUrl: "nope" }, { PLUSWITHAI_API_KEY: KEY })).toThrow(/--app-url/);
  });
});

describe("redact", () => {
  it("replaces the configured key", () => {
    expect(redact(`Bearer ${KEY} failed`, KEY)).toBe("Bearer pwai_… failed");
  });

  it("replaces anything shaped like a key, even another one", () => {
    expect(redact("token pwai_ZZZZZZZZZZZZZZZZZZZZZZZZ and more")).toBe("token pwai_… and more");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("nothing to hide", KEY)).toBe("nothing to hide");
    expect(redact("pwai_ alone")).toBe("pwai_ alone");
  });
});
