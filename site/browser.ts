/**
 * The text pipeline (panics, exceptions, sanitizer reports) running in the
 * browser for the demo site. Same parsers, rules and renderer as the CLI.
 */
import { parseFailure } from "../src/failure.js";
import { toFailureIssue } from "../src/failureIssue.js";
import { renderIssueMarkdown, type Issue } from "../src/issue.js";

export type Analysis =
  | { readonly ok: true; readonly issue: Issue; readonly markdown: string }
  | { readonly ok: false; readonly message: string };

export function analyze(text: string, name: string): Analysis {
  const parsed = parseFailure(text);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  const issue = toFailureIssue(parsed.value, name, text);
  return { ok: true, issue, markdown: renderIssueMarkdown(issue) };
}
