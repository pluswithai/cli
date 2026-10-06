/** The real process behind MainDeps: Node's fetch, streams, clock and files. */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
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
  };
}
