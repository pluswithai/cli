/**
 * Client for the public Pluswithai REST API (https://pluswithai.com/docs/integrations-and-api) over
 * an injected fetch. Every failure becomes an ApiError whose message is safe
 * to print: the API key is redacted from it.
 */
import { redact } from "./config.js";
import { VERSION } from "./version.js";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "error";

export interface RunResult {
  id: string;
  project: string;
  testFiles: string[];
  status: RunStatus;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Milliseconds. */
  duration: number;
  /** Unix ms, when the run was requested. */
  timestamp: number;
  scheduled: boolean;
  timedOut?: boolean;
  environment?: string;
  baseUrl?: string;
}

/** Where a run goes instead of the project URL: a named environment or a preview deploy. */
export interface RunTarget {
  environment?: string;
  baseUrl?: string;
}

export interface Project {
  name: string;
  displayName?: string;
  url: string;
  createdAt: string;
}

export interface Me {
  userId: string;
  email: string | null;
  isAdmin?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer. */
    readonly status: number,
    /** Worth retrying: network failures, 429 and 5xx. */
    readonly transient: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_TEXT = 200;

export interface ClientOptions {
  apiUrl: string;
  apiKey: string;
  fetch: typeof fetch;
}

export class Client {
  constructor(private readonly opts: ClientOptions) {}

  me(): Promise<Me> {
    return this.request<Me>("GET", "/me");
  }

  async projects(): Promise<Project[]> {
    return (await this.request<{ projects: Project[] }>("GET", "/projects")).projects;
  }

  async testFiles(project: string): Promise<string[]> {
    return (await this.request<{ files: string[] }>("GET", `/projects/${encodeURIComponent(project)}/test-files`)).files;
  }

  async runs(project: string, limit: number): Promise<RunResult[]> {
    return (await this.request<{ runs: RunResult[] }>("GET", `/projects/${encodeURIComponent(project)}/runs?limit=${limit}`)).runs;
  }

  async run(project: string, id: string): Promise<RunResult> {
    const path = `/projects/${encodeURIComponent(project)}/runs/${encodeURIComponent(id)}`;
    return (await this.request<{ run: RunResult }>("GET", path)).run;
  }

  async startRun(project: string, tests: string[], region?: string, target: RunTarget = {}): Promise<RunResult[]> {
    const body = {
      tests,
      ...(region ? { region } : {}),
      ...(target.environment ? { environment: target.environment } : {}),
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    };
    return (await this.request<{ results: RunResult[] }>("POST", `/projects/${encodeURIComponent(project)}/run-tests`, body)).results;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const host = new URL(this.opts.apiUrl).host;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      Accept: "application/json",
      "User-Agent": `pluswithai-cli/${VERSION}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    // Unbound on purpose: some fetch implementations reject a foreign `this`.
    const doFetch = this.opts.fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.opts.apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      const reason = name === "TimeoutError" || name === "AbortError" ? "timed out" : e instanceof Error ? e.message : String(e);
      throw new ApiError(this.clean(`Could not reach ${host}: ${reason}`), 0, true);
    }

    const text = await res.text();
    if (!res.ok) {
      let message = "";
      let retryAfter: number | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: unknown; retryAfterSeconds?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
        if (typeof parsed.retryAfterSeconds === "number") retryAfter = parsed.retryAfterSeconds;
      } catch {
        message = text.trim();
      }
      if (retryAfter === undefined) {
        const header = Number(res.headers.get("Retry-After"));
        if (Number.isFinite(header) && header > 0) retryAfter = header;
      }
      message = (message || res.statusText || "Request failed").slice(0, MAX_ERROR_TEXT);
      const transient = res.status === 429 || res.status >= 500;
      throw new ApiError(this.clean(`${res.status} ${message}`), res.status, transient, retryAfter);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(`${res.status} Unexpected response from the API`, res.status, false);
    }
  }

  private clean(message: string): string {
    return redact(message, this.opts.apiKey);
  }
}
