# `@pluswithai/cli` — specification

Status: v0.2 implemented (2026-10-06; v0.1 on 2026-10-05). Source: https://github.com/pluswithai/cli.

The CLI is a thin, dependency-free client of the public Pluswithai REST API
(https://pluswithai.com/docs/integrations-and-api). It turns "start runs, wait, decide" into one
command with output that reads well in a CI log, and it carries the stdio
bridge to Pluswithai's MCP server (`pluswithai mcp`).

## 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript → plain ESM JavaScript** | npm runs JavaScript; `npx @pluswithai/cli` works anywhere Node is, which is every CI image and every machine that runs Claude Code / Cursor. Same language as the backend: shared shapes, one toolchain. Go would need a binary per OS/arch shipped through `optionalDependencies` (the esbuild pattern) for no gain at this size. |
| Runtime deps | **None** | The CLI handles an API key; every dependency is supply-chain surface. Node ≥ 18 has `fetch`, `node:util` `parseArgs`, `AbortSignal.timeout`. |
| Node | **≥ 18.3** | First release with both global `fetch` and `node:util` `parseArgs` (verified on 18.20). |
| API key | **Only from `PLUSWITHAI_API_KEY`** | A `--api-key` flag leaks into shell history and `ps`. Never printed; redacted from every error message. |
| Tests | Vitest, **100 % lines/branches/functions/statements**, enforced in config | Every I/O edge (fetch, env, clock, stdout, files) is injected, so everything is testable without a network. |

## 2. Commands

```
pluswithai run      --project <name> [--test <file>]... [--region <id>]
                    [--timeout <s>] [--interval <s>] [--junit <path>] [--json] [--no-summary]
pluswithai projects [--json]
pluswithai tests    --project <name> [--json]
pluswithai runs     --project <name> [--limit <n>] [--json]
pluswithai whoami   [--json]
pluswithai mcp      [--api-url <url>]
pluswithai --help | -h        pluswithai <command> --help
pluswithai --version | -v
```

Global options: `--api-url <url>` (env `PLUSWITHAI_API_URL`, default
`https://api.pluswithai.com`), `--app-url <url>` (env `PLUSWITHAI_APP_URL`,
default `https://pluswithai.com`). Flags beat env; env beats defaults.

### 2.1 `run`

1. Tests = every `--test`, or every file from `GET /projects/:p/test-files`.
   No tests → exit 2.
2. `POST /projects/:p/run-tests` `{ tests, region? }` → one run per file
   (`results[].id`). On **429** wait `retryAfterSeconds` (default 10, cap 60)
   and retry, at most 3 times.
3. Poll every pending run with `GET /projects/:p/runs/:id` every `--interval`
   seconds (default 5) until its status is `passed`, `failed` or `error`.
   Up to 3 consecutive transient poll errors (network, 5xx, 429) per round
   are tolerated; a 4th fails the command (exit 3).
4. Deadline `--timeout` seconds (default 1800), counted from when the runs
   start — waiting out a 429 does not eat into it. Hit it → exit 4, listing
   what was still running.
5. Progress lines on **stderr** as each run finishes:
   `✓ tests/cart.spec.ts  passed  12.3s` / `✗ … failed …` / `! … error …`.
6. Summary on **stdout**: counts, a table, and the app link. `--json` prints
   one JSON document instead (`{ project, passed, results: [...] , exitCode }`).
7. In GitHub Actions:
   - `GITHUB_STEP_SUMMARY` set and no `--no-summary` → append a Markdown table.
   - `GITHUB_ACTIONS=true` → one `::error title=…::…` annotation per failed run.
8. `--junit <path>` writes JUnit XML (one `<testcase>` per file; failures and
   errors carry the first lines of stderr/stdout).

### 2.2 Read commands

`projects`, `tests`, `runs`, `whoami` print a small table / list (or JSON with
`--json`). `runs --limit` defaults to 10, range 1–100.

## 3. Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; for `run`, every run passed |
| 1 | At least one run **failed** (your test or your app) |
| 2 | Usage or configuration error (bad flag, missing key, no tests) |
| 3 | Pluswithai or network error, or a run ended in `error` (our pipeline) |
| 4 | `run` timed out waiting for results |

`failed` beats `error` beats timeout when several apply: the most actionable
answer for the developer wins.

## 4. Errors and secrets

- HTTP errors surface the API's `{ error }` message with the status:
  `401 Invalid or revoked API key`.
- 401 adds a hint: "Check PLUSWITHAI_API_KEY (create one under Integrations →
  API keys)". 403 on `run` adds "This key needs the CI (read + run) access".
- The key value is replaced by `pwai_…` in any message before printing.
- A key not starting with `pwai_` is a configuration error (exit 2), caught
  before any request.

## 5. Layout

```
src/
  args.ts      argv → command (pure)
  config.ts    flags + env → config (pure)
  client.ts    REST client over an injected fetch
  run.ts       start → poll → results (injected clock/sleep)
  report.ts    text, Markdown, JUnit, JSON renderers (pure)
  main.ts      wires everything; returns the exit code
  bin.ts       process entry: main(process…) then process.exit
  version.ts   VERSION (a test keeps it equal to package.json)
```

## 5.1 Integration test

`test/e2e.test.ts` builds nothing itself: it runs `dist/bin.js` (after
`npm run build`) as a real child process against a local HTTP server that
mimics the API, and asserts output and exit codes. It is excluded from unit
coverage (separate process) but runs in `npm test`.

### 2.3 `mcp` (v0.2)

A stdio MCP server that relays each JSON-RPC line to `<api-url>/mcp` with the
key (https://pluswithai.com/docs/ai-agents-mcp). Tools live on the server, so the
CLI never goes stale. Requests run concurrently; responses are written one
per line as they arrive; a 202 (notification) writes nothing. The negotiated
`MCP-Protocol-Version` from `initialize` is sent on every later request.
HTTP or network failures become JSON-RPC errors (code -32001) for each id in
the message; failed notifications are only logged. stdout is the protocol,
logs go to stderr. Exits 0 when stdin closes and every answer is written.

## 6. Releases

- Tag `vX.Y.Z` on `main` → `.github/workflows/publish.yml` runs typecheck,
  the full suite (100% coverage gate) and the build, then
  `npm publish --provenance --access public` through npm Trusted Publishing
  (OIDC): no npm token is stored anywhere, and npm shows which commit of
  this repository built each version.
- `VERSION` in `src/version.ts` must equal `package.json` (a test checks it).

## 7. Later

- A GitHub Action (`action.yml` in this repo) that runs `npx @pluswithai/cli run`.
