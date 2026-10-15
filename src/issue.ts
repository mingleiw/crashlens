/**
 * The common shape of every crashlens report, whatever produced it (a core
 * dump, a panic message, ...). Producers build an Issue; renderers only read
 * Issues, so every input type gets the same Markdown, JSON and batch grouping.
 */
export interface Issue {
  /** Where the failure came from. */
  readonly source:
    | "core"
    | "go-panic"
    | "rust-panic"
    | "python-exception"
    | "java-exception"
    | "node-exception"
    | "sanitizer";
  /** Stable crash class, e.g. "null-pointer-dereference" or "go-nil-map-write". */
  readonly kind: string;
  /** Short crash class title, e.g. "NULL pointer dereference". */
  readonly title: string;
  /** Best "where" for a person: first frame in the user's code, if known. */
  readonly where: string | null;
  /** One paragraph, Markdown. */
  readonly summary: string;
  /** Label/value rows for the details table; values are Markdown. */
  readonly facts: readonly IssueFact[];
  readonly sections: readonly IssueSection[];
  /** Source locations from the stack, the program's own frames first. */
  readonly locations: readonly IssueLocation[];
  readonly cause: string;
  readonly nextSteps: readonly string[];
  readonly confidence: "high" | "medium" | "low";
  readonly warnings: readonly string[];
  /** Evidence bullets (hashes, tool status, inputs); Markdown. */
  readonly evidence: readonly string[];
  readonly limitations: readonly string[];
  /** ASLR- and path-independent grouping key. */
  readonly signature: string;
  /** Italic closing line. */
  readonly footer: string;
}

export interface IssueLocation {
  readonly file: string;
  readonly line: number;
  readonly function: string;
  readonly own: boolean;
}

export interface IssueFact {
  readonly label: string;
  readonly value: string;
}

export type IssueSection =
  | {
      readonly heading: string;
      readonly kind: "code";
      readonly language: string;
      readonly lines: readonly string[];
    }
  | {
      readonly heading: string;
      readonly kind: "list";
      readonly items: readonly string[];
    };

/** Full issue title, e.g. "Crash: NULL pointer dereference in `sum+0x31`". */
function issuePrefix(issue: Issue): "Crash" | "Panic" | "Exception" {
  return issue.source === "core" || issue.source === "sanitizer"
    ? "Crash"
    : issue.source.endsWith("-panic")
      ? "Panic"
      : "Exception";
}

export function issueTitle(issue: Issue): string {
  const prefix = issuePrefix(issue);
  return issue.where === null
    ? `${prefix}: ${issue.title}`
    : `${prefix}: ${issue.title} in \`${issue.where}\``;
}

/**
 * Render as a GitHub-flavored Markdown issue. `depth` shifts every heading
 * down so an issue can be embedded under another document's headings.
 */
export function renderIssueMarkdown(issue: Issue, depth = 0): string {
  const h = (level: number) => "#".repeat(Math.min(6, level + depth));
  const lines: string[] = [
    `${h(1)} ${issueTitle(issue)}`,
    "",
    `${h(2)} Summary`,
    "",
    issue.summary,
    "",
    `${h(2)} ${issuePrefix(issue)} details`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...issue.facts.map((fact) => `| ${fact.label} | ${cell(fact.value)} |`),
    `| Classification confidence | ${issue.confidence} |`,
    `| Signature | \`${issue.signature}\` |`,
    "",
  ];
  for (const section of issue.sections) {
    lines.push(`${h(2)} ${section.heading}`, "");
    if (section.kind === "code")
      lines.push("```" + section.language, ...section.lines, "```", "");
    else lines.push(...section.items.map((item) => `- ${item}`), "");
  }
  lines.push(
    `${h(2)} Likely cause`,
    "",
    issue.cause,
    "",
    `${h(2)} Suggested next steps`,
    "",
    ...issue.nextSteps.map((step) => `- [ ] ${step}`),
    "",
  );
  if (issue.warnings.length > 0)
    lines.push(
      `${h(2)} Warnings`,
      "",
      ...issue.warnings.map((warning) => `- ⚠️ ${warning}`),
      "",
    );
  lines.push(
    "<details>",
    "<summary>Evidence and limitations</summary>",
    "",
    ...issue.evidence.map((item) => `- ${item}`),
    ...issue.limitations.map((item) => `- ${item}`),
    "",
    "</details>",
    "",
    `_${issue.footer}_`,
    "",
  );
  return lines.join("\n");
}

/**
 * Attach the tail of an application log, for inputs that carry no log
 * themselves (core dumps). Lines are the last ones before end of file.
 */
export function withLog(issue: Issue, lines: readonly string[]): Issue {
  if (lines.length === 0) return issue;
  return {
    ...issue,
    sections: [
      ...issue.sections,
      { heading: "Last log lines", kind: "code", language: "", lines },
    ],
  };
}

/** Table cells cannot contain raw pipes or newlines. */
function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** JSON with bigints as hex strings and the given keys dropped. */
export function toJson(value: unknown, omit: readonly string[] = []): string {
  return JSON.stringify(
    value,
    (key, item: unknown) =>
      typeof item === "bigint"
        ? `0x${item.toString(16)}`
        : omit.includes(key)
          ? undefined
          : item,
    2,
  );
}
