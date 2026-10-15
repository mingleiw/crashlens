import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { toCoreIssue } from "./coreIssue.js";
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
/** Panic text files larger than this are skipped rather than read. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const ET_CORE = 4;

type Candidate =
  | { readonly kind: "core"; readonly path: string }
  | { readonly kind: "text"; readonly path: string }
  | { readonly kind: "skip"; readonly path: string; readonly reason: string };

/** Triage every core dump and panic log under a directory and group duplicates. */
export async function triageBatch(options: BatchOptions): Promise<BatchResult> {
  const files = await listFiles(options.directory);
  const candidates = await Promise.all(files.map(detect));
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
      const text = await readFile(candidate.path, "utf8");
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
      `<summary>Full report for <code>${g.files[0]}</code></summary>`,
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

async function listFiles(directory: string, depth = 0): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) files.push(...(await listFiles(path, depth + 1)));
    } else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Classify by content, not name: ELF ET_CORE, or small text files. */
async function detect(path: string): Promise<Candidate> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(18);
    const { bytesRead } = await handle.read(head, 0, 18, 0);
    if (bytesRead >= 18 && head.readUInt32BE(0) === 0x7f454c46)
      return head.readUInt16LE(16) === ET_CORE
        ? { kind: "core", path }
        : { kind: "skip", path, reason: "ELF file that is not a core dump" };
    const size = (await stat(path)).size;
    if (size > MAX_TEXT_BYTES)
      return { kind: "skip", path, reason: "larger than 8 MiB and not a core dump" };
    if (head.subarray(0, bytesRead).includes(0))
      return { kind: "skip", path, reason: "binary file that is not a core dump" };
    return { kind: "text", path };
  } finally {
    await handle.close();
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
