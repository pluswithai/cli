/** The real process behind MainDeps: Node's fetch, streams, clock and files. */
import { spawn } from "node:child_process";
import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { MainDeps } from "./main.js";
import type { Env } from "./config.js";

export function nodeDeps(proc: { argv: string[]; env: Env; stdin?: NodeJS.ReadableStream }): MainDeps {
  return {
    argv: proc.argv.slice(2),
    env: proc.env,
    // Unbound on purpose: Node's fetch must not be called as a method of another object.
    fetch: (input, init) => fetch(input, init),
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, "utf8");
    },
    stdinLines: () => createInterface({ input: proc.stdin ?? process.stdin, crlfDelay: Infinity }),
    appendFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, data, "utf8");
    },
    readText: (path) => readFile(path, "utf8").catch(() => null),
    writeBytes: async (path, bytes) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    remove: (path) => rm(path, { force: true }),
    exists: (path) => access(path).then(() => true, () => false),
    spawn: (command, args, opts) =>
      new Promise((resolve, reject) => {
        // npm and npx are .cmd scripts on Windows: they need a shell there.
        const child = spawn(command, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: "inherit", shell: process.platform === "win32" });
        child.once("error", reject);
        // No code means a signal ended it: a failure.
        child.once("exit", (code) => resolve(code ?? 1));
      }),
  };
}
