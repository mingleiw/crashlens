import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { Issue, IssueLocation, IssueSection } from "./issue.js";

/** How many distinct locations get a code snippet. */
const MAX_SNIPPETS = 3;
const CONTEXT_LINES = 3;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Bounds for the basename search fallback. */
const MAX_SCAN_FILES = 50_000;
const MAX_SCAN_DEPTH = 10;
const SKIP_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "vendor", ".venv", "venv", "__pycache__", ".gradle", ".idea"]);
const GIT_TIMEOUT_MS = 5_000;

const FENCE: Readonly<Record<string, string>> = {
  ".py": "python", ".java": "java", ".kt": "kotlin", ".js": "javascript", ".mjs": "javascript",
  ".cjs": "javascript", ".ts": "typescript", ".go": "go", ".rs": "rust", ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
};

export interface SourceSnippet {
  readonly location: IssueLocation;
  /** Path relative to the source root. */
  readonly path: string;
  readonly lines: readonly string[];
  readonly blame: Blame | null;
}

export interface Blame {
  readonly commit: string;
  readonly author: string;
  readonly date: string;
  readonly summary: string;
}

/**
 * Add code snippets (and git blame when the root is a repository) for the
 * issue's own-code locations. Only files inside `root` are read: candidate
 * paths are resolved with realpath and rejected if they leave the root.
 */
export async function attachSource(issue: Issue, root: string): Promise<Issue> {
  const realRoot = await realpath(root);
  let index: Map<string, string[]> | null = null;
  const lookup = async (name: string) => {
    index ??= await indexByBasename(realRoot);
    return index.get(name) ?? [];
  };

  const seen = new Set<string>();
  const snippets: SourceSnippet[] = [];
  for (const location of issue.locations.filter((l) => l.own)) {
    if (snippets.length >= MAX_SNIPPETS) break;
    const file = await resolveFile(realRoot, location, lookup);
    if (file === null) continue;
    const key = `${file}:${location.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = await snippet(file, location.line);
    if (lines === null) continue;
    snippets.push({
      location,
      path: relative(realRoot, file),
      lines,
      blame: await blame(realRoot, file, location.line),
    });
  }
  if (snippets.length === 0)
    return { ...issue, evidence: [...issue.evidence, `Source: none of the failing lines were found under \`${root}\``] };

  const sections: IssueSection[] = snippets.map((s) => ({
    heading: `Code: ${s.path}:${s.location.line} (${s.location.function})`,
    kind: "code",
    language: FENCE[extname(s.path)] ?? "",
    lines: s.lines,
  }));
  const blamed = snippets.filter((s) => s.blame !== null);
  if (blamed.length > 0)
    sections.push({
      heading: "Last change to these lines",
      kind: "list",
      items: blamed.map((s) => {
        const b = s.blame as Blame;
        return b.commit === "uncommitted"
          ? `\`${s.path}:${s.location.line}\`: not committed yet (local change)`
          : `\`${s.path}:${s.location.line}\`: ${b.author}, ${b.date}, \`${b.commit}\` "${b.summary}"`;
      }),
    });
  // Code goes right after the stack trace, before secondary stacks and logs.
  const at = issue.sections.findIndex((s) => s.heading === "Stack trace" || s.heading === "Backtrace");
  const merged = [...issue.sections];
  merged.splice(at === -1 ? 0 : at + 1, 0, ...sections);
  return {
    ...issue,
    sections: merged,
    evidence: [...issue.evidence, `Source: ${snippets.length} location${snippets.length === 1 ? "" : "s"} read from \`${root}\``],
  };
}

/**
 * Map a stack frame's file to a file inside the root. Tries, in order: the
 * path itself, ever-shorter suffixes of it under the root, the Java package
 * path, and finally files with the same name (preferring the longest
 * matching path suffix).
 */
async function resolveFile(
  root: string,
  location: IssueLocation,
  lookup: (name: string) => Promise<string[]>,
): Promise<string | null> {
  const segments = location.file.split(/[\\/]+/).filter((s) => s !== "" && s !== "." && s !== "..");
  const candidates: string[] = [];
  if (isAbsolute(location.file)) candidates.push(location.file);
  for (let k = 0; k < segments.length; k++) candidates.push(join(root, ...segments.slice(k)));
  if (location.file.endsWith(".java") || location.file.endsWith(".kt")) {
    const parts = location.function.split(".");
    const packagePath = parts.slice(0, -2);
    for (const prefix of ["", "src/main/java", "src/main/kotlin", "src", "app/src/main/java"])
      candidates.push(join(root, prefix, ...packagePath, location.file));
  }
  for (const candidate of candidates) {
    const safe = await inside(root, candidate);
    if (safe !== null) return safe;
  }

  const sameName = await lookup(basename(location.file));
  const ranked = sameName
    .map((path) => ({ path, score: commonSuffix(path.split(sep), segments) }))
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 1 || (ranked[0] && ranked[1] && ranked[0].score > ranked[1].score))
    return inside(root, (ranked[0] as { path: string }).path);
  return null;
}

/** The real path of `candidate` if it is a regular file inside `root`. */
async function inside(root: string, candidate: string): Promise<string | null> {
  try {
    const real = await realpath(candidate);
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    const info = await stat(real);
    return info.isFile() && info.size <= MAX_FILE_BYTES ? real : null;
  } catch {
    return null;
  }
}

function commonSuffix(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

async function indexByBasename(root: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  let count = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || count >= MAX_SCAN_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_SCAN_FILES) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        count++;
        const list = index.get(entry.name) ?? [];
        list.push(join(dir, entry.name));
        index.set(entry.name, list);
      }
    }
  };
  await walk(root, 0);
  return index;
}

/** Numbered lines around `line`, the failing one marked with ">". */
async function snippet(file: string, line: number): Promise<string[] | null> {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  if (line < 1 || line > lines.length) return null;
  const from = Math.max(1, line - CONTEXT_LINES);
  const to = Math.min(lines.length, line + CONTEXT_LINES);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++)
    out.push(`${n === line ? ">" : " "} ${String(n).padStart(width)} | ${lines[n - 1] ?? ""}`);
  return out;
}

/** `git blame` for one line; null outside a repository or on any git error. */
function blame(root: string, file: string, line: number): Promise<Blame | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "blame", "--porcelain", "-L", `${line},${line}`, "--", relative(root, file)],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const sha = /^([0-9a-f]{40}) /.exec(stdout)?.[1];
        if (sha === undefined) {
          resolve(null);
          return;
        }
        if (/^0+$/.test(sha)) {
          resolve({ commit: "uncommitted", author: "", date: "", summary: "" });
          return;
        }
        const field = (name: string) => new RegExp(`^${name} (.*)$`, "m").exec(stdout)?.[1] ?? "";
        const time = Number(field("author-time"));
        resolve({
          commit: sha.slice(0, 8),
          author: field("author"),
          date: Number.isFinite(time) && time > 0 ? new Date(time * 1000).toISOString().slice(0, 10) : "",
          summary: field("summary"),
        });
      },
    );
  });
}
