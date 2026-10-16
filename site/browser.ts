/**
 * The text pipeline (panics, exceptions, sanitizer reports) running in the
 * browser for the demo site. Same parsers, rules and renderer as the CLI.
 */
import { parseFailure } from "../src/failure.js";
import { logContext, toFailureIssue } from "../src/failureIssue.js";
import { renderIssueMarkdown, withLog, type Issue } from "../src/issue.js";

export type Analysis =
  | { readonly ok: true; readonly issue: Issue; readonly markdown: string }
  | { readonly ok: false; readonly message: string };

export function analyze(text: string, name: string): Analysis {
  const parsed = parseFailure(text);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  const issue = toFailureIssue(parsed.value, name, text);
  return { ok: true, issue, markdown: renderIssueMarkdown(issue) };
}

/** Adds the app log's last lines to a report, as the local server does for cores. */
export function attachLog(issue: Issue, log: string): { readonly issue: Issue; readonly markdown: string } {
  const withLines = log === "" ? issue : withLog(issue, logContext(log, log.length));
  return { issue: withLines, markdown: renderIssueMarkdown(withLines) };
}
