// A stand-in for the Pluswithai API, just enough for `pluswithai run`:
// list test files, start runs, report them. Every request is appended to a
// JSON-lines log so the workflow can check what the Action really sent.
// A test whose name contains "fail" fails; the rest pass. Each run reports
// "running" once before its verdict, so the CLI has to poll.
//
//   node fake-api.mjs <port> <log file> <api key>
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, logFile, apiKey] = process.argv.slice(2);
const runs = new Map();

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  appendFileSync(logFile, JSON.stringify({ method: req.method, url: req.url, body, auth: req.headers.authorization }) + "\n");

  if (req.url === "/health") return json(res, 200, { ok: true });
  if (req.headers.authorization !== `Bearer ${apiKey}`) return json(res, 401, { error: "Invalid API key" });

  const m = req.url.match(/^\/projects\/([^/]+)\/(test-files|run-tests|runs\/([^/?]+))$/);
  if (!m) return json(res, 404, { error: "Not found" });
  const [, project, action, runId] = m;

  if (action === "test-files" && req.method === "GET") return json(res, 200, { files: ["home.spec.ts"] });

  if (action === "run-tests" && req.method === "POST") {
    const results = body.tests.map((test, i) => {
      const run = {
        id: `run-${runs.size + i + 1}`,
        project,
        testFiles: [test],
        status: "running",
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 0,
        timestamp: Date.now(),
        scheduled: false,
        environment: body.environment ?? (body.baseUrl ? "preview" : "production"),
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
      };
      return run;
    });
    for (const r of results) runs.set(r.id, r);
    return json(res, 200, { results });
  }

  const run = runs.get(runId);
  if (!run || req.method !== "GET") return json(res, 404, { error: "Run not found" });
  const failed = run.testFiles[0].includes("fail");
  Object.assign(run, {
    status: failed ? "failed" : "passed",
    exitCode: failed ? 1 : 0,
    duration: 1234,
    stdout: failed ? "1 failed" : "1 passed",
  });
  return json(res, 200, { run });
}).listen(Number(port), "127.0.0.1");
