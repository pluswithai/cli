/**
 * `pluswithai pull` and `pluswithai local` (SPEC.md §2.1.1): a project's tests on
 * this machine. The API exports the files HEAD tracks, already portable (no
 * container paths, no secrets); they are written under a folder, then
 * Playwright runs there with npm's own tooling. All I/O comes through
 * LocalDeps, so this is tested without a disk or a process.
 */
import type { Client } from "./client.js";

export interface LocalDeps {
  readText(path: string): Promise<string | null>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Runs a command with this terminal's stdio; resolves with its exit code, rejects when it cannot start. */
  spawn(command: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }): Promise<number>;
  log(text: string): void;
}

/** Something on this machine is missing or failed to set up: exit code 2. */
export class LocalSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSetupError";
  }
}

/** Where the pulled file list is kept, so the next pull removes what the project dropped. */
export const MANIFEST = ".pluswithai/pulled.json";

export const defaultDir = (project: string) => `pluswithai/${project.replace(/[^\w.-]+/g, "-")}`;

const join = (dir: string, rel: string) => `${dir.replace(/\/+$/, "")}/${rel}`;

/** A path the API sent, as a safe path under the folder — or null (absolute, `..`, odd characters). */
export function safeRelativePath(path: string): string | null {
  const p = path.replace(/^\/+/, "");
  if (!p || p.includes("\\") || p.includes("\0")) return null;
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return p;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readManifest(deps: Pick<LocalDeps, "readText">, dir: string): Promise<string[]> {
  const text = await deps.readText(join(dir, MANIFEST));
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string" && safeRelativePath(p) === p) : [];
  } catch {
    return [];
  }
}

export interface PullResult {
  dir: string;
  written: number;
  removed: number;
  skipped: string[];
  headOid: string | null;
}

export async function pullProject(
  deps: Pick<LocalDeps, "readText" | "writeBytes" | "remove">,
  client: Pick<Client, "exportFiles">,
  project: string,
  dir: string,
): Promise<PullResult> {
  const exported = await client.exportFiles(project);
  const previous = await readManifest(deps, dir);
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of exported.files) {
    const rel = safeRelativePath(f.path);
    if (!rel || rel === MANIFEST) {
      skipped.push(f.path);
      continue;
    }
    await deps.writeBytes(join(dir, rel), decodeBase64(f.base64));
    written.push(rel);
  }
  const keep = new Set(written);
  const stale = previous.filter((p) => !keep.has(p));
  for (const p of stale) await deps.remove(join(dir, p));
  await deps.writeBytes(join(dir, MANIFEST), new TextEncoder().encode(JSON.stringify(written.sort(), null, 2) + "\n"));
  return { dir, written: written.length, removed: stale.length, skipped, headOid: exported.headOid };
}

export function playwrightArgs(tests: string[], headed: boolean): string[] {
  return ["playwright", "test", ...tests, ...(headed ? ["--headed"] : [])];
}

export interface TestLocallyOptions {
  project: string;
  dir: string;
  tests: string[];
  baseUrl?: string;
  headed: boolean;
  pull: boolean;
  env: Record<string, string | undefined>;
}

async function step(deps: LocalDeps, label: string, command: string, args: string[], cwd: string, env: Record<string, string | undefined>): Promise<void> {
  deps.log(label);
  let code: number;
  try {
    code = await deps.spawn(command, args, { cwd, env });
  } catch (e) {
    throw new LocalSetupError(`Could not start ${command}: ${e instanceof Error ? e.message : String(e)}. Install Node.js 18 or later (it brings npm and npx).`);
  }
  if (code !== 0) throw new LocalSetupError(`${command} ${args.join(" ")} exited with ${code}.`);
}

/**
 * Pull (unless told not to), install once (npm install + Chromium), run
 * `npx playwright test` with PLUSWITHAI_BASE_URL when a base URL is given.
 * Resolves 0 when Playwright passes, 1 when it fails.
 */
export async function testLocally(deps: LocalDeps, client: Pick<Client, "exportFiles">, opts: TestLocallyOptions): Promise<number> {
  if (opts.pull) {
    const pulled = await pullProject(deps, client, opts.project, opts.dir);
    deps.log(`Pulled ${pulled.written} files into ${pulled.dir}${pulled.removed ? ` (removed ${pulled.removed})` : ""}.`);
  } else if (!(await deps.exists(join(opts.dir, "playwright.config.ts")))) {
    throw new LocalSetupError(`${opts.dir} has no project yet. Run without --no-pull, or run "pluswithai pull" first.`);
  }
  if (!(await deps.exists(join(opts.dir, "node_modules")))) {
    await step(deps, "Installing dependencies (first run)…", "npm", ["install", "--no-audit", "--no-fund"], opts.dir, opts.env);
    await step(deps, "Installing Chromium for Playwright…", "npx", ["playwright", "install", "chromium"], opts.dir, opts.env);
  }
  const env = { ...opts.env, ...(opts.baseUrl ? { PLUSWITHAI_BASE_URL: opts.baseUrl } : {}) };
  let code: number;
  try {
    code = await deps.spawn("npx", playwrightArgs(opts.tests, opts.headed), { cwd: opts.dir, env });
  } catch (e) {
    throw new LocalSetupError(`Could not start npx: ${e instanceof Error ? e.message : String(e)}. Install Node.js 18 or later.`);
  }
  return code === 0 ? 0 : 1;
}
