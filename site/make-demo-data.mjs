// Generates site/demo-data.json: real crashlens reports for the demo's
// preloaded bugs. Run after `npm run build`, from the repo root:
//
//   node site/make-demo-data.mjs --source DIR [--core CORE --binary BIN]
//
// --source points at a git checkout containing the sample shop.py so the
// Python reports include code and blame; --core/--binary add the native crash
// behind the demo's "Try a sample core dump" button (needs REA and
// REA_PWNTOOLS_PYTHON, like the CLI). Only the report is published, never the
// core: build site/sample/parser.c and capture the core with an empty
// environment (`env -i ./parser config.ini`) so the report shows nothing local.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { toCoreIssue } from "../dist/src/coreIssue.js";
import { parseFailure } from "../dist/src/failure.js";
import { toFailureIssue } from "../dist/src/failureIssue.js";
import { renderIssueMarkdown } from "../dist/src/issue.js";
import { resolveReaCommand } from "../dist/src/rea.js";
import { attachSource } from "../dist/src/source.js";
import { triage } from "../dist/src/triage.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => readFileSync(join(root, "test", "fixtures", name), "utf8");
const { values } = parseArgs({ options: { source: { type: "string" }, core: { type: "string" }, binary: { type: "string" } } });

/** [file name shown in the demo, fixture path] */
const SAMPLES = [
  ["api.log", "failures/node-undef.txt"],
  ["order-service.asan.log", "failures/asan-uaf.txt"],
  ["billing.log", "failures/java-cause.txt"],
  ["shop-go.log", "panics/go-nil.txt"],
  ["worker-1.log", "failures/py-none.txt"],
  ["worker-2.log", "failures/py-none.txt"],
  ["worker-3.log", "failures/py-none.txt"],
];

const issues = [];
let id = 0;
const entry = (name, issue) => {
  id += 1;
  return { id: `sample-${id}`, name, at: "2026-10-15T02:14:00.000Z", issue, markdown: renderIssueMarkdown(issue) };
};
const add = (name, issue) => issues.push(entry(name, issue));

for (const [name, path] of SAMPLES) {
  const text = fixture(path);
  const parsed = parseFailure(text);
  if (!parsed.ok) throw new Error(`${path}: ${parsed.error.message}`);
  let issue = toFailureIssue(parsed.value, name, text);
  if (values.source && name.startsWith("worker")) issue = await attachSource(issue, values.source);
  add(name, scrub(issue, values.source ? [[values.source, "~/code/shop"]] : []));
}

let sample;
if (values.core && values.binary) {
  const result = await triage({ corePath: values.core, binaryPath: values.binary, rea: resolveReaCommand(), gdb: "gdb" });
  if (!result.ok) throw new Error(result.error.message);
  const shown = [[values.core, "parser.core"], [values.binary, basename(values.binary)]];
  sample = entry("parser.core", scrub(toCoreIssue(result.value), shown));
}

writeFileSync(join(root, "site", "demo-data.json"), `${JSON.stringify({ issues, sample }, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v), 1)}\n`);
console.log(`wrote ${issues.length} sample reports`);

/** Replace local paths with the names a visitor should see. */
function scrub(issue, replacements) {
  let text = JSON.stringify(issue, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v));
  for (const [from, to] of replacements) text = text.replaceAll(from, to);
  return JSON.parse(text);
}
