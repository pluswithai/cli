/**
 * Everything the CLI prints or writes, as pure functions (SPEC.md §2):
 * progress lines, the text summary, the GitHub step summary (Markdown),
 * GitHub annotations, JUnit XML, the --json document and the tables of
 * the read commands.
 */
import type { Me, Project, RunResult, RunStatus } from "./client.js";
import { DEFAULT_APP_URL } from "./config.js";
import type { RunOutcome } from "./run.js";

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function appLink(appUrl: string, project: string): string {
  return `${appUrl}/app?project=${encodeURIComponent(project)}`;
}

const fileOf = (r: RunResult) => r.testFiles.join(", ");
const SYMBOL: Record<RunStatus, string> = { passed: "✓", failed: "✗", error: "!", queued: "·", running: "·" };

export function progressLine(r: RunResult): string {
  const status = `${r.status}${r.timedOut ? " (timed out)" : ""}`;
  return `${SYMBOL[r.status]} ${fileOf(r)}  ${status}  ${formatDuration(r.duration)}`;
}

export function startedLine(project: string, count: number): string {
  return `Started ${count} run${count === 1 ? "" : "s"} in ${project}. Waiting for results…`;
}

function counts(outcome: RunOutcome) {
  const of = (s: string) => outcome.results.filter((r) => r.status === s).length;
  return { passed: of("passed"), failed: of("failed"), error: of("error"), pending: outcome.pending.length };
}

function countsLine(outcome: RunOutcome): string {
  const c = counts(outcome);
  return [`${c.passed} passed`, c.failed ? `${c.failed} failed` : "", c.error ? `${c.error} error` : ""].filter(Boolean).join(", ");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function summaryText(outcome: RunOutcome, project: string, appUrl: string): string {
  const lines = [`Pluswithai · ${project}: ${countsLine(outcome)}`];
  for (const r of outcome.results) if (r.status !== "passed") lines.push(`  ${progressLine(r)}`);
  if (outcome.pending.length) {
    lines.push(`Timed out waiting for ${plural(outcome.pending.length, "run")}: ${outcome.pending.map(fileOf).join(", ")}`);
  }
  lines.push(`Details: ${appLink(appUrl, project)}`);
  return lines.join("\n");
}

// ── GitHub ───────────────────────────────────────────────────────────────

const MD_STATUS: Record<string, string> = { passed: "✅ passed", failed: "❌ failed", error: "⚠️ error" };
const mdCell = (text: string) => text.replace(/\|/g, "\\|");

export function markdownSummary(outcome: RunOutcome, project: string, appUrl: string): string {
  const broken = outcome.results.some((r) => r.status !== "passed");
  const icon = broken ? "❌" : outcome.timedOut ? "⏱️" : "✅";
  const rows = [
    ...outcome.results.map((r) => `| \`${mdCell(fileOf(r))}\` | ${MD_STATUS[r.status]} | ${formatDuration(r.duration)} |`),
    ...outcome.pending.map((r) => `| \`${mdCell(fileOf(r))}\` | ⏱️ still running | — |`),
  ];
  return [
    `### ${icon} Pluswithai · ${project}`,
    "",
    countsLine(outcome),
    "",
    "| Test | Status | Duration |",
    "|---|---|---|",
    ...rows,
    "",
    `[Open in Pluswithai](${appLink(appUrl, project)})`,
    "",
  ].join("\n");
}

const MAX_EXCERPT_LINES = 12;
const MAX_EXCERPT_CHARS = 1000;

/**
 * Playwright's first failure block ("1) file:line › title", the assertion,
 * the code frame) without the run banner before it or the attachment list
 * after it; else from the first "Error:" line; else the start of the text.
 */
function excerpt(r: RunResult): string {
  const text = r.stdout.trim() || r.stderr.trim();
  const lines = text.split("\n");
  let start = lines.findIndex((l) => /^\s*\d+\) /.test(l));
  if (start === -1) start = lines.findIndex((l) => /\w*Error:/.test(l));
  if (start === -1) start = 0;
  let end = lines.findIndex((l, i) => i > start && /^\s*(attachment #\d+|\d+ (failed|passed|flaky|skipped)\b)/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start, Math.min(end, start + MAX_EXCERPT_LINES)).join("\n").trim().slice(0, MAX_EXCERPT_CHARS);
}

// GitHub workflow-command escaping (as in @actions/core).
const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function annotations(outcome: RunOutcome): string[] {
  return outcome.results
    .filter((r) => r.status !== "passed")
    .map((r) => {
      const message = excerpt(r) || "The run failed. Open it in Pluswithai for the video and trace.";
      return `::error title=${escapeProperty(`Pluswithai · ${fileOf(r)} ${r.status}`)}::${escapeData(message)}`;
    });
}

// ── JUnit ────────────────────────────────────────────────────────────────

const MAX_JUNIT_OUTPUT = 4000;
const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const secs = (ms: number) => (ms / 1000).toFixed(3);

export function junitXml(outcome: RunOutcome, project: string): string {
  const c = counts(outcome);
  const total = outcome.results.reduce((sum, r) => sum + r.duration, 0);
  const cases = [
    ...outcome.results.map((r) => {
      const open = `<testcase name="${xml(fileOf(r))}" classname="${xml(project)}" time="${secs(r.duration)}"`;
      if (r.status === "passed") return `${open}/>`;
      const tag = r.status === "failed" ? "failure" : "error";
      const output = `${r.stdout}\n${r.stderr}`.trim().slice(-MAX_JUNIT_OUTPUT);
      return `${open}><${tag} message="${r.status}">${xml(output)}</${tag}></testcase>`;
    }),
    ...outcome.pending.map(
      (r) =>
        `<testcase name="${xml(fileOf(r))}" classname="${xml(project)}" time="0.000"><skipped message="Timed out waiting for the result"/></testcase>`,
    ),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `<testsuite name="${xml(`Pluswithai · ${project}`)}" tests="${outcome.results.length + c.pending}" failures="${c.failed}" errors="${c.error}" skipped="${c.pending}" time="${secs(total)}">`,
    ...cases,
    "</testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

// ── JSON ─────────────────────────────────────────────────────────────────

export function runJson(outcome: RunOutcome, project: string, appUrl: string) {
  return {
    project,
    url: appLink(appUrl, project),
    passed: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    counts: counts(outcome),
    results: outcome.results.map((r) => ({
      id: r.id,
      file: fileOf(r),
      status: r.status,
      durationMs: r.duration,
      timedOut: r.timedOut === true,
    })),
    pending: outcome.pending.map((r) => ({ id: r.id, file: fileOf(r), status: r.status })),
  };
}

// ── Read commands ────────────────────────────────────────────────────────

export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  "))
    .join("\n");
}

export function projectsText(projects: Project[], appUrl: string = DEFAULT_APP_URL): string {
  if (projects.length === 0) return `No projects yet. Create one at ${appUrl}/app`;
  return table([
    ["NAME", "TITLE", "URL", "CREATED"],
    ...projects.map((p) => [p.name, p.displayName || "-", p.url, p.createdAt ? p.createdAt.slice(0, 10) : "-"]),
  ]);
}

export function testsText(project: string, files: string[]): string {
  return files.length === 0 ? `No test files in ${project}.` : files.join("\n");
}

const startedAt = (ms: number) => {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
};

export function runsText(project: string, runs: RunResult[]): string {
  if (runs.length === 0) return `No runs yet in ${project}.`;
  return table([
    ["ID", "STATUS", "TESTS", "DURATION", "TRIGGER", "STARTED"],
    ...runs.map((r) => [
      r.id,
      r.status,
      r.testFiles.length === 1 ? r.testFiles[0]! : `${r.testFiles.length} files`,
      formatDuration(r.duration),
      r.scheduled ? "scheduled" : "manual",
      startedAt(r.timestamp),
    ]),
  ]);
}

export function whoamiText(me: Pick<Me, "userId" | "email">, apiUrl: string): string {
  return `Authenticated with an API key as account ${me.userId}${me.email ? ` (${me.email})` : ""}\nAPI: ${apiUrl}`;
}
