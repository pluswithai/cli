/**
 * argv → command (SPEC.md §2). Pure: no environment, no I/O. Built on
 * node:util parseArgs so the CLI keeps zero runtime dependencies.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";

export type CommandName = "run" | "projects" | "tests" | "runs" | "whoami" | "mcp";
const COMMANDS: readonly CommandName[] = ["run", "projects", "tests", "runs", "whoami", "mcp"];

export interface GlobalFlags {
  apiUrl?: string;
  appUrl?: string;
}

export type Command =
  | { kind: "help"; topic?: CommandName }
  | { kind: "version" }
  | {
      kind: "run";
      global: GlobalFlags;
      project: string;
      tests: string[];
      region: string | undefined;
      timeoutSec: number;
      intervalSec: number;
      junit: string | undefined;
      json: boolean;
      summary: boolean;
    }
  | { kind: "projects"; global: GlobalFlags; json: boolean }
  | { kind: "tests"; global: GlobalFlags; project: string; json: boolean }
  | { kind: "runs"; global: GlobalFlags; project: string; limit: number; json: boolean }
  | { kind: "whoami"; global: GlobalFlags; json: boolean }
  | { kind: "mcp"; global: GlobalFlags };

export class UsageError extends Error {
  constructor(
    message: string,
    readonly topic?: CommandName,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

type Options = NonNullable<ParseArgsConfig["options"]>;

const GLOBAL: Options = {
  "api-url": { type: "string" },
  "app-url": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const PROJECT: Options = { project: { type: "string", short: "p" } };

const OPTIONS: Record<CommandName, Options> = {
  run: {
    ...GLOBAL,
    ...PROJECT,
    test: { type: "string", short: "t", multiple: true },
    region: { type: "string" },
    timeout: { type: "string" },
    interval: { type: "string" },
    junit: { type: "string" },
    "no-summary": { type: "boolean" },
  },
  projects: GLOBAL,
  tests: { ...GLOBAL, ...PROJECT },
  runs: { ...GLOBAL, ...PROJECT, limit: { type: "string" } },
  whoami: GLOBAL,
  mcp: { "api-url": GLOBAL["api-url"]!, help: GLOBAL.help! },
};

const isCommand = (value: string | undefined): value is CommandName => COMMANDS.includes(value as CommandName);

function seconds(value: string | undefined, fallback: number, flag: string, topic: CommandName): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number of seconds.`, topic);
  return n;
}

export function parseCommand(argv: string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") return { kind: "help" };
  if (first === "--version" || first === "-v") return { kind: "version" };
  if (first === "help") {
    if (rest[0] === undefined) return { kind: "help" };
    if (!isCommand(rest[0])) throw new UsageError(`Unknown command "${rest[0]}". Run pluswithai --help.`);
    return { kind: "help", topic: rest[0] };
  }
  if (!isCommand(first)) throw new UsageError(`Unknown command "${first}". Run pluswithai --help.`);
  const topic = first;

  if (rest.some((a) => a === "--api-key" || a.startsWith("--api-key="))) {
    throw new UsageError("There is no --api-key flag: set PLUSWITHAI_API_KEY in the environment instead.", topic);
  }

  let values: Record<string, string | boolean | Array<string | boolean> | undefined>;
  try {
    ({ values } = parseArgs({ args: rest, options: OPTIONS[topic], strict: true, allowPositionals: false }));
  } catch (e) {
    throw new UsageError((e as Error).message, topic);
  }
  if (values.help) return { kind: "help", topic };

  const global: GlobalFlags = {};
  if (typeof values["api-url"] === "string") global.apiUrl = values["api-url"];
  if (typeof values["app-url"] === "string") global.appUrl = values["app-url"];
  const json = values.json === true;
  const project = typeof values.project === "string" ? values.project : undefined;
  const needProject = () => {
    if (!project) throw new UsageError("Missing --project <name>.", topic);
    return project;
  };

  switch (topic) {
    case "run":
      return {
        kind: "run",
        global,
        project: needProject(),
        tests: (values.test as string[] | undefined) ?? [],
        region: values.region as string | undefined,
        timeoutSec: seconds(values.timeout as string | undefined, 1800, "--timeout", topic),
        intervalSec: seconds(values.interval as string | undefined, 5, "--interval", topic),
        junit: values.junit as string | undefined,
        json,
        summary: values["no-summary"] !== true,
      };
    case "projects":
      return { kind: "projects", global, json };
    case "tests":
      return { kind: "tests", global, project: needProject(), json };
    case "runs": {
      const raw = values.limit as string | undefined;
      const limit = raw === undefined ? 10 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new UsageError("--limit must be a whole number from 1 to 100.", topic);
      }
      return { kind: "runs", global, project: needProject(), limit, json };
    }
    case "whoami":
      return { kind: "whoami", global, json };
    case "mcp":
      return { kind: "mcp", global };
  }
}

const GLOBAL_HELP = `Global options:
  --api-url <url>   API base URL (env PLUSWITHAI_API_URL, default https://api.pluswithai.com)
  --app-url <url>   App URL for links (env PLUSWITHAI_APP_URL, default https://pluswithai.com)
  --json            Machine-readable output
  -h, --help        Show help`;

const HELP: Record<CommandName, string> = {
  run: `Usage: pluswithai run --project <name> [options]

Start runs, wait for them and exit with their verdict.

Options:
  -p, --project <name>   Project to run (required)
  -t, --test <file>      Test file to run; repeat for several (default: every test file)
  --region <id>          Run region (default: the project's)
  --timeout <seconds>    Give up waiting after this long (default 1800)
  --interval <seconds>   Time between status checks (default 5)
  --junit <path>         Also write a JUnit XML report
  --no-summary           Do not write the GitHub step summary

${GLOBAL_HELP}

Exit codes:
  0  every run passed        1  a run failed
  2  usage or configuration  3  Pluswithai or network error
  4  timed out waiting`,
  projects: `Usage: pluswithai projects [--json]

List the projects of the account.

${GLOBAL_HELP}`,
  tests: `Usage: pluswithai tests --project <name> [--json]

List a project's test files.

${GLOBAL_HELP}`,
  runs: `Usage: pluswithai runs --project <name> [--limit <n>] [--json]

Show a project's recent runs.

Options:
  -p, --project <name>   Project (required)
  --limit <n>            How many (1–100, default 10)

${GLOBAL_HELP}`,
  mcp: `Usage: pluswithai mcp [--api-url <url>]

Run a local MCP server over stdio that relays to Pluswithai's MCP endpoint,
for agents that only start local servers. Configure your client with:

  { "command": "npx", "args": ["-y", "@pluswithai/cli", "mcp"],
    "env": { "PLUSWITHAI_API_KEY": "pwai_…" } }

Use a key with Agent access to get every tool. Logs go to stderr.

Options:
  --api-url <url>   API base URL (env PLUSWITHAI_API_URL)
  -h, --help        Show help`,
  whoami: `Usage: pluswithai whoami [--json]

Check that the API key works and show which account it belongs to.

${GLOBAL_HELP}`,
};

export function helpText(topic?: CommandName): string {
  if (topic) return HELP[topic];
  return `Usage: pluswithai <command> [options]

Run Pluswithai tests from CI and the terminal.

Commands:
  run        Start runs, wait for the results, exit non-zero on failure
  projects   List your projects
  tests      List a project's test files
  runs       Show a project's recent runs
  whoami     Check the API key
  mcp        Serve Pluswithai's MCP tools over stdio (for AI agents)

Authentication:
  Set PLUSWITHAI_API_KEY to a key from the app's API keys page.

Run "pluswithai <command> --help" for a command's options.`;
}
