/**
 * Flags + environment → the settings every command needs (SPEC.md §2, §4).
 * The API key only ever comes from the environment.
 */
import type { GlobalFlags } from "./args.js";

export const DEFAULT_API_URL = "https://api.pluswithai.com";
export const DEFAULT_APP_URL = "https://pluswithai.com";

export interface Config {
  apiKey: string;
  apiUrl: string;
  appUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Env = Record<string, string | undefined>;

function httpUrl(value: string, flag: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${flag} must be an http(s) URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError(`${flag} must be an http(s) URL.`);
  return value.replace(/\/+$/, "");
}

export function resolveConfig(flags: GlobalFlags, env: Env): Config {
  const apiKey = (env.PLUSWITHAI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new ConfigError(
      "PLUSWITHAI_API_KEY is not set. Create a key on the app's API keys page and export it.",
    );
  }
  if (!apiKey.startsWith("pwai_")) {
    throw new ConfigError("PLUSWITHAI_API_KEY does not look like a Pluswithai key (they start with pwai_).");
  }
  return {
    apiKey,
    apiUrl: httpUrl(flags.apiUrl ?? env.PLUSWITHAI_API_URL ?? DEFAULT_API_URL, "--api-url"),
    appUrl: httpUrl(flags.appUrl ?? env.PLUSWITHAI_APP_URL ?? DEFAULT_APP_URL, "--app-url"),
  };
}

/** Removes the key — and anything shaped like a Pluswithai key — from text about to be printed. */
export function redact(text: string, key?: string): string {
  const out = key ? text.split(key).join("pwai_…") : text;
  return out.replace(/pwai_[A-Za-z0-9_-]{16,}/g, "pwai_…");
}
