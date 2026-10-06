/**
 * `pluswithai mcp`: a stdio MCP server that relays every JSON-RPC message
 * to the remote Pluswithai MCP endpoint (https://pluswithai.com/docs/ai-agents-mcp). The tools, their
 * validation and their permissions live on the server; this file only moves
 * messages, so it never goes out of date with them.
 *
 * stdout is the protocol: one JSON message per line, nothing else. Logs go
 * to stderr. Requests are relayed concurrently, so a long run_tests never
 * holds up a ping.
 */
import { redact } from "./config.js";
import { VERSION } from "./version.js";

export interface ProxyDeps {
  apiUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  /** Writes one protocol line (no trailing newline). */
  write(line: string): void;
  log(message: string): void;
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; result?: { protocolVersion?: unknown } };

/** Ours, not the spec's: -32000..-32099 is reserved for implementation errors. */
const UPSTREAM_ERROR = -32001;

export function createMcpProxy(deps: ProxyDeps) {
  const endpoint = `${deps.apiUrl}/mcp`;
  const host = new URL(deps.apiUrl).host;
  let protocolVersion: string | null = null;

  const emit = (message: unknown) => deps.write(JSON.stringify(message));

  /** Every request id in the outgoing message (a batch has several; notifications none). */
  const idsOf = (payload: Message | Message[]) =>
    (Array.isArray(payload) ? payload : [payload]).filter((m) => m.id !== undefined && m.id !== null).map((m) => m.id!);

  const fail = (payload: Message | Message[], message: string) => {
    const clean = redact(message, deps.apiKey);
    const ids = idsOf(payload);
    if (ids.length === 0) deps.log(clean);
    for (const id of ids) emit({ jsonrpc: "2.0", id, error: { code: UPSTREAM_ERROR, message: clean } });
  };

  const deliver = (message: Message) => {
    if (typeof message.result?.protocolVersion === "string") protocolVersion = message.result.protocolVersion;
    emit(message);
  };

  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let payload: Message | Message[];
    try {
      payload = JSON.parse(line) as Message | Message[];
    } catch {
      emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the line is not JSON" } });
      return;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${deps.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": `pluswithai-cli/${VERSION} (mcp)`,
    };
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;

    const doFetch = deps.fetch;
    let res: Response;
    try {
      res = await doFetch(endpoint, { method: "POST", headers, body: line });
    } catch (e) {
      fail(payload, `Pluswithai: Could not reach ${host}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (res.status === 202) return;
    const text = await res.text();
    if (!res.ok) {
      let detail = "";
      try {
        const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
        detail = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : "";
      } catch {
        detail = "";
      }
      const hint = res.status === 401 ? ". Check PLUSWITHAI_API_KEY." : "";
      fail(payload, `Pluswithai: ${res.status} ${detail || res.statusText || "request failed"}${hint}`);
      return;
    }

    if ((res.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
      for (const raw of text.split("\n")) {
        if (raw.startsWith("data:")) deliver(JSON.parse(raw.slice(5).trim()) as Message);
      }
      return;
    }
    let body: Message | Message[];
    try {
      body = JSON.parse(text) as Message | Message[];
    } catch {
      fail(payload, `Pluswithai: Unexpected response from ${host}`);
      return;
    }
    for (const message of Array.isArray(body) ? body : [body]) deliver(message);
  }

  return { handleLine };
}

/** Relays every line until stdin closes, then waits for the answers still in flight. */
export async function runMcpProxy(deps: ProxyDeps & { lines: AsyncIterable<string> }): Promise<number> {
  const proxy = createMcpProxy(deps);
  const inFlight = new Set<Promise<void>>();
  for await (const line of deps.lines) {
    const p = proxy.handleLine(line).finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  await Promise.all(inFlight);
  return 0;
}
