import { describe, expect, it, vi } from "vitest";
import { ApiError, Client } from "../src/client.js";
import { run } from "./fixtures.js";
import { VERSION } from "../src/version.js";

const KEY = "pwai_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function client(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call.url, call.init);
  });
  return { c: new Client({ apiUrl: "https://api.example", apiKey: KEY, fetch: fetchFn as unknown as typeof fetch }), calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });


describe("Client requests", () => {
  it("sends the key, JSON accept and a versioned user agent", async () => {
    const { c, calls } = client(() => json({ userId: "u1", email: null }));
    await c.me();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("https://api.example/me");
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers.Accept).toBe("application/json");
    expect(headers["User-Agent"]).toBe(`pluswithai-cli/${VERSION}`);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("me", async () => {
    const { c } = client(() => json({ userId: "u1", email: "a@b.c", isAdmin: false }));
    expect(await c.me()).toEqual({ userId: "u1", email: "a@b.c", isAdmin: false });
  });

  it("projects", async () => {
    const { c } = client(() => json({ projects: [{ name: "shop", url: "https://shop.example", createdAt: "2026-01-01" }] }));
    expect(await c.projects()).toEqual([{ name: "shop", url: "https://shop.example", createdAt: "2026-01-01" }]);
  });

  it("testFiles encodes the project name", async () => {
    const { c, calls } = client(() => json({ files: ["tests/a.spec.ts"] }));
    expect(await c.testFiles("my shop")).toEqual(["tests/a.spec.ts"]);
    expect(calls[0]!.url).toBe("https://api.example/projects/my%20shop/test-files");
  });

  it("runs passes the limit", async () => {
    const { c, calls } = client(() => json({ runs: [run()], total: 1 }));
    expect(await c.runs("shop", 5)).toEqual([run()]);
    expect(calls[0]!.url).toBe("https://api.example/projects/shop/runs?limit=5");
  });

  it("run fetches one run", async () => {
    const { c, calls } = client(() => json({ run: run({ id: "r/9" }), artifacts: [] }));
    expect((await c.run("shop", "r/9")).id).toBe("r/9");
    expect(calls[0]!.url).toBe("https://api.example/projects/shop/runs/r%2F9");
  });

  it("startRun posts the tests (and region when given)", async () => {
    const { c, calls } = client(() => json({ results: [run({ status: "queued" })], async: true }, 202));
    expect(await c.startRun("shop", ["a.spec.ts"], "weur")).toEqual([run({ status: "queued" })]);
    expect(calls[0]!.url).toBe("https://api.example/projects/shop/run-tests");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ tests: ["a.spec.ts"], region: "weur" });
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    await c.startRun("shop", ["a.spec.ts"]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ tests: ["a.spec.ts"] });

    await c.startRun("shop", ["a.spec.ts"], undefined, { environment: "staging" });
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ tests: ["a.spec.ts"], environment: "staging" });
    await c.startRun("shop", ["a.spec.ts"], "weur", { baseUrl: "https://shop-git-x.vercel.app" });
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ tests: ["a.spec.ts"], region: "weur", baseUrl: "https://shop-git-x.vercel.app" });
  });
});

describe("Client errors", () => {
  it("surfaces the API's error message with the status", async () => {
    const { c } = client(() => json({ error: "Invalid or revoked API key" }, 401));
    const err = await c.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: "401 Invalid or revoked API key", transient: false });
  });

  it("reads retryAfterSeconds from the body, else from Retry-After", async () => {
    const fromBody = client(() => json({ error: "slow down", retryAfterSeconds: 7 }, 429));
    expect(await fromBody.c.me().catch((e: unknown) => e)).toMatchObject({ status: 429, retryAfterSeconds: 7, transient: true });
    const fromHeader = client(() => json({ error: "slow down" }, 429, { "Retry-After": "12" }));
    expect(await fromHeader.c.me().catch((e: unknown) => e)).toMatchObject({ retryAfterSeconds: 12 });
    const none = client(() => json({ error: "slow down" }, 429, { "Retry-After": "soon" }));
    expect(await none.c.me().catch((e: unknown) => e)).toMatchObject({ retryAfterSeconds: undefined });
  });

  it("treats 5xx as transient and falls back to the body text or status text", async () => {
    const text = client(() => new Response("upstream exploded", { status: 502 }));
    expect(await text.c.me().catch((e: unknown) => e)).toMatchObject({ status: 502, message: "502 upstream exploded", transient: true });
    const empty = client(() => new Response("", { status: 503, statusText: "Service Unavailable" }));
    expect(await empty.c.me().catch((e: unknown) => e)).toMatchObject({ message: "503 Service Unavailable" });
    const bare = client(() => new Response("", { status: 500 }));
    expect(await bare.c.me().catch((e: unknown) => e)).toMatchObject({ message: "500 Request failed" });
  });

  it("cuts a huge error body", async () => {
    const { c } = client(() => new Response("x".repeat(1000), { status: 500 }));
    const err = (await c.me().catch((e: unknown) => e)) as ApiError;
    expect(err.message.length).toBeLessThan(260);
  });

  it("wraps network failures as transient, naming the host", async () => {
    const { c } = client(() => { throw new TypeError("fetch failed"); });
    expect(await c.me().catch((e: unknown) => e)).toMatchObject({
      status: 0,
      transient: true,
      message: "Could not reach api.example: fetch failed",
    });
  });

  it("names a timeout as such", async () => {
    const { c } = client(() => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); });
    expect(await c.me().catch((e: unknown) => e)).toMatchObject({ message: "Could not reach api.example: timed out" });
  });

  it("handles a non-Error throw", async () => {
    const { c } = client(() => { throw "boom"; });
    expect(await c.me().catch((e: unknown) => e)).toMatchObject({ message: "Could not reach api.example: boom" });
  });

  it("rejects a 2xx that is not JSON", async () => {
    const { c } = client(() => new Response("<html>", { status: 200 }));
    expect(await c.me().catch((e: unknown) => e)).toMatchObject({ status: 200, message: "200 Unexpected response from the API", transient: false });
  });

  it("never puts the key in an error message", async () => {
    const { c } = client(() => json({ error: `bad token ${KEY}` }, 401));
    const err = (await c.me().catch((e: unknown) => e)) as ApiError;
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("pwai_…");
  });
});
