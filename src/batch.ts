import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { toCoreIssue } from "./coreIssue.js";
import { detectFile } from "./fileKind.js";
import { issueTitle, renderIssueMarkdown, type Issue } from "./issue.js";
import { parseFailure } from "./failure.js";
import { toFailureIssue } from "./failureIssue.js";
import type { ReaCommand } from "./rea.js";
import { triage } from "./triage.js";

export interface BatchOptions {
  readonly directory: string;
  /** Binary for core dumps; panics need none. */
  readonly binaryPath: string | null;
  readonly rea: ReaCommand;
  readonly gdb: string | null;
  /** Optional step applied to each group's representative issue (e.g. source snippets). */
  readonly enrich?: (issue: Issue) => Promise<Issue>;
  /** Core triage runs REA and gdb, so keep this small. */
  readonly concurrency?: number;
}

export interface BatchGroup {
  readonly signature: string;
  readonly files: readonly string[];
  /** Report for the first file in the group. */
  readonly issue: Issue;
}

export interface BatchResult {
  readonly directory: string;
  readonly failures: number;
  readonly groups: readonly BatchGroup[];
  readonly skipped: readonly { readonly file: string; readonly reason: string }[];
}

const MAX_DEPTH = 4;

type Candidate =
  | { readonly kind: "core"; readonly path: string }
  | { readonly kind: "text"; readonly path: string }
  | { readonly kind: "skip"; readonly path: string; readonly reason: string };

/** Triage every core dump and panic log under a directory and group duplicates. */
export async function triageBatch(options: BatchOptions): Promise<BatchResult> {
  const unreadable: Candidate[] = [];
  const files = await listFiles(options.directory, unreadable);
  if (files.length > MAX_BATCH_FILES)
    throw new Error(`${options.directory} has more than ${MAX_BATCH_FILES} files; point --batch at a smaller folder.`);
  const candidates: Candidate[] = [...unreadable];
  await forEachLimit(files, 16, async (file) => {
    try {
      candidates.push(await detect(file));
    } catch (error) {
      candidates.push({ kind: "skip", path: file, reason: `could not read: ${errorMessage(error)}` });
    }
  });
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  const issues: { file: string; issue: Issue }[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const name = (path: string) => relative(options.directory, path) || path;

  const cores: string[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "skip") {
      skipped.push({ file: name(candidate.path), reason: candidate.reason });
    } else if (candidate.kind === "core") {
      if (options.binaryPath === null)
        skipped.push({
          file: name(candidate.path),
          reason: "core dump needs the crashed binary: crashlens --batch DIR BINARY",
        });
      else cores.push(candidate.path);
    } else {
      let text: string;
      try {
        text = await readFile(candidate.path, "utf8");
      } catch (error) {
        skipped.push({ file: name(candidate.path), reason: `could not read: ${errorMessage(error)}` });
        continue;
      }
      const parsed = parseFailure(text);
      if (parsed.ok)
        issues.push({
          file: name(candidate.path),
          issue: toFailureIssue(parsed.value, name(candidate.path), text),
        });
      else skipped.push({ file: name(candidate.path), reason: "no crash, panic, exception or sanitizer report found" });
    }
  }

  await forEachLimit(cores, options.concurrency ?? 2, async (core) => {
    const result = await triage({
      corePath: core,
      binaryPath: options.binaryPath as string,
      rea: options.rea,
      gdb: options.gdb,
    });
    if (result.ok) issues.push({ file: name(core), issue: toCoreIssue(result.value) });
    else skipped.push({ file: name(core), reason: result.error.message });
  });

  const groups = group(issues);
  const enrich = options.enrich;
  return {
    directory: options.directory,
    failures: issues.length,
    groups: enrich === undefined ? groups : await Promise.all(groups.map(async (g) => ({ ...g, issue: await enrich(g.issue) }))),
    skipped: skipped.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

function group(issues: readonly { file: string; issue: Issue }[]): BatchGroup[] {
  const bySignature = new Map<string, { file: string; issue: Issue }[]>();
  for (const entry of [...issues].sort((a, b) => a.file.localeCompare(b.file))) {
    const list = bySignature.get(entry.issue.signature) ?? [];
    list.push(entry);
    bySignature.set(entry.issue.signature, list);
  }
  return [...bySignature.entries()]
    .map(([signature, entries]) => ({
      signature,
      files: entries.map((entry) => entry.file),
      issue: (entries[0] as { issue: Issue }).issue,
    }))
    .sort(
      (a, b) =>
        b.files.length - a.files.length ||
        issueTitle(a.issue).localeCompare(issueTitle(b.issue)),
    );
}

export function renderBatchMarkdown(result: BatchResult): string {
  const distinct = result.groups.length;
  const lines: string[] = [
    `# crashlens: ${result.failures} failure${result.failures === 1 ? "" : "s"}, ${distinct} distinct bug${distinct === 1 ? "" : "s"}`,
    "",
  ];
  if (distinct > 0)
    lines.push(
      "| # | Bug | Where | Count | Signature |",
      "| --- | --- | --- | --- | --- |",
      ...result.groups.map(
        (g, index) =>
          `| ${index + 1} | ${g.issue.title} | ${g.issue.where === null ? "unknown" : `\`${g.issue.where}\``} | **${g.files.length}** | \`${g.signature}\` |`,
      ),
      "",
    );
  else lines.push("No core dumps or failure logs were triaged.", "");
  if (result.skipped.length > 0)
    lines.push(`Skipped ${result.skipped.length} file${result.skipped.length === 1 ? "" : "s"} (listed at the end).`, "");

  result.groups.forEach((g, index) => {
    const shown = g.files.slice(0, 10).map((file) => `\`${file}\``);
    const more = g.files.length > 10 ? `, … (+${g.files.length - 10} more)` : "";
    lines.push(
      "---",
      "",
      `## ${index + 1}. ${issueTitle(g.issue).replace(/^(Crash|Panic): /, "")} (${g.files.length}×)`,
      "",
      g.issue.cause,
      "",
      `Files: ${shown.join(", ")}${more}`,
      "",
      "<details>",
      `<summary>Full report for <code>${escapeHtml(g.files[0] ?? "")}</code></summary>`,
      "",
      renderIssueMarkdown(g.issue, 2),
      "</details>",
      "",
    );
  });

  if (result.skipped.length > 0)
    lines.push(
      "---",
      "",
      "## Skipped",
      "",
      ...result.skipped.map((s) => `- \`${s.file}\`: ${s.reason}`),
      "",
    );
  lines.push("_Generated by crashlens; no program was executed._", "");
  return lines.join("\n");
}

/** Files under `directory`; folders below it that cannot be listed go to `unreadable`, not fatal. */
async function listFiles(directory: string, unreadable: Candidate[], depth = 0): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (depth === 0) throw new Error(`Could not read ${directory}: ${errorMessage(error)}`);
    unreadable.push({ kind: "skip", path: directory, reason: `could not read folder: ${errorMessage(error)}` });
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) files.push(...(await listFiles(path, unreadable, depth + 1)));
    } else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function detect(path: string): Promise<Candidate> {
  const found = await detectFile(path);
  switch (found.kind) {
    case "core":
      return { kind: "core", path };
    case "text":
      return { kind: "text", path };
    case "binary":
      return { kind: "skip", path, reason: "ELF file that is not a core dump" };
    case "other":
      return { kind: "skip", path, reason: found.reason };
  }
}

async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await run(item);
    }
  });
  await Promise.all(workers);
}

const MAX_BATCH_FILES = 10_000;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** `EACCES: permission denied, open '…'` → `permission denied (EACCES)`, without the path. */
function errorMessage(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  if (typeof e?.code === "string") return `${e.message.replace(/^[A-Z]+: /, "").replace(/, \w+ '.*'$/, "")} (${e.code})`;
  return e instanceof Error ? e.message : String(error);
}
