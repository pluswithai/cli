# @pluswithai/cli

Run your [Pluswithai](https://pluswithai.com) tests from CI and the terminal.
It starts the runs, waits for them and exits non-zero when one fails.

- No runtime dependencies. Node 18.3 or later.
- Readable CI logs, a GitHub step summary, failure annotations and JUnit XML.
- Your API key is only read from the environment, and it is never printed.

## Quick start

1. In the app, open **API keys** in the sidebar, choose **Create key**, then pick **CI**.
2. Export the key, then run your project's tests:

```sh
export PLUSWITHAI_API_KEY=pwai_…
npx @pluswithai/cli run --project shop
```

```
Started 2 runs in shop. Waiting for results…
✓ tests/home.spec.ts  passed  8.4s
✗ tests/checkout.spec.ts  failed  21.0s
Pluswithai · shop: 1 passed, 1 failed
  ✗ tests/checkout.spec.ts  failed  21.0s
Details: https://pluswithai.com/app?project=shop
```

## GitHub Actions

Store the key as the repository secret `PLUSWITHAI_API_KEY`:

```yaml
name: Pluswithai tests
on: [push, workflow_dispatch]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx -y @pluswithai/cli run --project shop --junit reports/pluswithai.xml
        env:
          PLUSWITHAI_API_KEY: ${{ secrets.PLUSWITHAI_API_KEY }}
```

Inside GitHub Actions, the CLI also:

- writes a table of the results to the job's summary page (turn it off with `--no-summary`);
- adds an error annotation for every failed test.

## Commands

| Command | What it does |
|---|---|
| `pluswithai run --project <name>` | Start runs, wait for them, exit with their verdict |
| `pluswithai projects` | List your projects |
| `pluswithai tests --project <name>` | List a project's test files |
| `pluswithai runs --project <name>` | Show recent runs (`--limit`, 1–100) |
| `pluswithai whoami` | Check that the key works |
| `pluswithai mcp` | Serve Pluswithai's MCP tools over stdio, for AI agents |

Every command takes `--help`, and every command except `mcp` takes `--json`.

## AI agents (MCP)

Pluswithai is also an MCP server. With it, an agent like Claude Code, Cursor or Codex can run your tests, read the failures, push new tests and schedule them.

Clients that support remote MCP servers connect straight to `https://api.pluswithai.com/mcp`. Claude.ai and ChatGPT sign in with OAuth, so you don't copy a key. Clients that only start local servers can use this CLI as a stdio bridge:

```json
{
  "mcpServers": {
    "pluswithai": {
      "command": "npx",
      "args": ["-y", "@pluswithai/cli", "mcp"],
      "env": { "PLUSWITHAI_API_KEY": "pwai_…" }
    }
  }
}
```

Use a key with **Agent** access to get every tool. Logs go to stderr; stdout carries only the protocol.

### `run` options

| Option | Default | |
|---|---|---|
| `-p, --project <name>` | — | Required |
| `-t, --test <file>` | every test file | Repeat it to run several files |
| `--region <id>` | the project's region | Where the browser runs |
| `--timeout <seconds>` | 1800 | Stop waiting after this long, counted from when the runs start |
| `--interval <seconds>` | 5 | Time between status checks |
| `--junit <path>` | — | Also write a JUnit XML report |
| `--no-summary` | — | Skip the GitHub step summary |

### Environment

| Variable | |
|---|---|
| `PLUSWITHAI_API_KEY` | Required. There is no `--api-key` flag, because flags end up in your shell history. |
| `PLUSWITHAI_API_URL` | Default `https://api.pluswithai.com` (or `--api-url`) |
| `PLUSWITHAI_APP_URL` | Default `https://pluswithai.com`, used for links (or `--app-url`) |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every run passed |
| 1 | A run failed: your test or your app |
| 2 | Usage or configuration error |
| 3 | Pluswithai or network error, or a run ended in `error` |
| 4 | Timed out waiting for results |

If several apply, the CLI reports the first one in this order: a failed run, then an error, then the timeout.

## Development

```sh
npm install
npm test        # builds, runs unit + end-to-end tests, enforces 100% coverage
```

The design is documented in [SPEC.md](SPEC.md).

## License

MIT
