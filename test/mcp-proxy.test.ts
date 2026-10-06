import { describe, expect, it, vi } from "vitest";
import { createMcpProxy, runMcpProxy } from "../src/mcp-proxy.js";
import { VERSION } from "../src/version.js";

const KEY = "pwai_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function harness(handler: (body: any, init: RequestInit) => Response | Promise<Response>) {
  const out: string[] = [];
  const logs: string[] = [];
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), init: init ?? {}, body });
    return handler(body, init ?? {});
  });
  const proxy = createMcpProxy({
    apiUrl: "https://api.example",
    apiKey: KEY,
    fetch: fetchFn as unknown as typeof fetch,
    write: (line) => out.push(line),
    log: (msg) => logs.push(msg),
  });
  return { proxy, out, logs, calls, parsed: () => out.map((l) => JSON.parse(l)) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createMcpProxy", () => {
  it("forwards a request with the key and writes the JSON response as one line", async () => {
    const h = harness((body) => json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(h.calls[0]!.url).toBe("https://api.example/mcp");
    const headers = h.calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers.Accept).toBe("application/json, text/event-stream");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe(`pluswithai-cli/${VERSION} (mcp)`);
    expect(h.out).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}']);
  });

  it("remembers the negotiated protocol version and sends it afterwards", async () => {
    const h = harness((body) =>
      body.method === "initialize"
        ? json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "pluswithai" } } })
        : json({ jsonrpc: "2.0", id: body.id, result: {} }),
    );
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect((h.calls[0]!.init.headers as Record<string, string>)["MCP-Protocol-Version"]).toBeUndefined();
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
    expect((h.calls[1]!.init.headers as Record<string, string>)["MCP-Protocol-Version"]).toBe("2025-06-18");
  });

  it("writes nothing for an accepted notification (202)", async () => {
    const h = harness(() => new Response(null, { status: 202 }));
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(h.out).toEqual([]);
  });

  it("unpacks a server-sent-events response, one message per data line", async () => {
    const h = harness(
      (body) =>
        new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: 1 } })}\n\n: comment\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }));
    expect(h.parsed()).toEqual([{ jsonrpc: "2.0", id: 7, result: { ok: 1 } }]);
  });

  it("writes a JSON-RPC batch response element by element", async () => {
    const h = harness(() => json([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]));
    await h.proxy.handleLine(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }]));
    expect(h.parsed().map((m) => m.id)).toEqual([1, 2]);
  });

  it("answers a parse error for a line that is not JSON, and ignores blank lines", async () => {
    const h = harness(() => json({}));
    await h.proxy.handleLine("   ");
    await h.proxy.handleLine("{nope");
    expect(h.calls).toHaveLength(0);
    expect(h.parsed()).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the line is not JSON" } }]);
  });

  it("turns an HTTP error into a JSON-RPC error for that request, with the API's message", async () => {
    const h = harness(() => json({ error: "invalid_token", error_description: "Invalid or revoked API key" }, 401));
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "a", method: "tools/list" }));
    expect(h.parsed()).toEqual([
      { jsonrpc: "2.0", id: "a", error: { code: -32001, message: "Pluswithai: 401 Invalid or revoked API key. Check PLUSWITHAI_API_KEY." } },
    ]);
  });

  it("uses the error field, or the status text, when there is no description", async () => {
    const h = harness(() => json({ error: "API keys can't call this endpoint." }, 403));
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }));
    expect(h.parsed()[0].error.message).toBe("Pluswithai: 403 API keys can't call this endpoint.");
    const bare = harness(() => new Response("oops", { status: 502, statusText: "Bad Gateway" }));
    await bare.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }));
    expect(bare.parsed()[0].error.message).toBe("Pluswithai: 502 Bad Gateway");
    const empty = harness(() => new Response("", { status: 500 }));
    await empty.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }));
    expect(empty.parsed()[0].error.message).toBe("Pluswithai: 500 request failed");
  });

  it("a failed batch answers an error for every request id in it, none for its notifications", async () => {
    const h = harness(() => json({ error: "down" }, 503));
    await h.proxy.handleLine(JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]));
    expect(h.parsed().map((m) => [m.id, m.error.message])).toEqual([
      [1, "Pluswithai: 503 down"],
      [2, "Pluswithai: 503 down"],
    ]);
  });

  it("falls back to the status text when the JSON error body has no message", async () => {
    const h = harness(() => new Response("{}", { status: 503, statusText: "Service Unavailable" }));
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }));
    expect(h.parsed()[0].error.message).toBe("Pluswithai: 503 Service Unavailable");
  });

  it("reads a JSON body even when the server sends no Content-Type", async () => {
    const h = harness((body) => new Response(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }))));
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }));
    expect(h.parsed()).toEqual([{ jsonrpc: "2.0", id: 5, result: {} }]);
  });

  it("only logs errors for notifications (they get no response)", async () => {
    const h = harness(() => json({ error: "nope" }, 500));
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }));
    expect(h.out).toEqual([]);
    expect(h.logs[0]).toContain("500 nope");
  });

  it("network failures become JSON-RPC errors, never leaking the key", async () => {
    const h = harness(() => { throw new TypeError(`connect failed ${KEY}`); });
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }));
    const msg = h.parsed()[0].error.message as string;
    expect(msg).toContain("Could not reach api.example");
    expect(msg).not.toContain(KEY);
    const thrown = harness(() => { throw "weird"; });
    await thrown.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }));
    expect(thrown.parsed()[0].error.message).toContain("weird");
  });

  it("an unreadable 200 body is an error too", async () => {
    const h = harness(() => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await h.proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }));
    expect(h.parsed()[0].error.message).toContain("Unexpected response");
  });
});

describe("runMcpProxy", () => {
  it("handles lines concurrently and waits for all of them before returning", async () => {
    const out: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/call") await slow;
      return json({ jsonrpc: "2.0", id: body.id, result: {} });
    });
    async function* lines() {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" });
      yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    }
    const done = runMcpProxy({
      apiUrl: "https://api.example",
      apiKey: KEY,
      fetch: fetchFn as unknown as typeof fetch,
      write: (l) => out.push(l),
      log: () => {},
      lines: lines(),
    });
    // The ping answers while the slow call is still in flight.
    await vi.waitFor(() => expect(out.map((l) => JSON.parse(l).id)).toEqual([2]));
    release();
    expect(await done).toBe(0);
    expect(out.map((l) => JSON.parse(l).id)).toEqual([2, 1]);
  });
});
