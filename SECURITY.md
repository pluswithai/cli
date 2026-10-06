# Security

`@pluswithai/cli` handles your Pluswithai API key, so we take reports seriously.

- **Report a vulnerability** through GitHub's
  [private vulnerability reporting](https://github.com/pluswithai/cli/security/advisories/new).
  Please don't open a public issue for it.
- We aim to answer within 3 business days.

## What the CLI does with your key

- It reads the key only from the `PLUSWITHAI_API_KEY` environment variable.
  There is no flag for it, because flags end up in shell history.
- It sends the key only in the `Authorization` header, and only to the API URL
  (`https://api.pluswithai.com` unless you set `--api-url` or
  `PLUSWITHAI_API_URL`).
- It never prints the key, never writes it to disk, and removes it from every
  error message.
- It has no runtime dependencies. Everything it runs is in this repository.

Each npm release is built by this repository's
[publish workflow](.github/workflows/publish.yml) with
[provenance](https://docs.npmjs.com/generating-provenance-statements), so you can
check which commit produced the version you installed.
