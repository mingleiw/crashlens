#!/usr/bin/env node
// A/B benchmark: does a crashlens report help a coding agent fix the root cause?
//
// For each case, condition A gives the agent the raw error output, condition B
// the same output plus the crashlens report. The agent (Claude Code, headless)
// edits a fresh copy; the diff is scored root / symptom / other from the
// patterns in cases.json. Runs the buggy case programs to capture their error
// output, and runs `claude`, which costs API usage.
//
//   npm run build && node bench/run.mjs [--model haiku] [--reps 3] [--cases js-await,py-queue] [--out DIR]
//   node bench/run.mjs --rescore DIR    # rescore saved runs after editing cases.json
//   CRASHLENS_CLI=/path/to/other/dist/src/cli.js node bench/run.mjs ...   # benchmark another build

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// CRASHLENS_CLI points at another build, to compare versions on the same cases.
const cli = process.env.CRASHLENS_CLI ?? resolve(here, "../dist/src/cli.js");
const { cases } = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const model = option("model", "");
const reps = Number(option("reps", "3"));
const selected = option("cases", Object.keys(cases).join(",")).split(",");
const out = resolve(option("rescore", null) ?? option("out", mkdtempSync(join(tmpdir(), "crashlens-bench-"))));
mkdirSync(out, { recursive: true });

const rescore = option("rescore", null);
const results = rescore === null ? [] : JSON.parse(readFileSync(join(rescore, "results.json"), "utf8"));
for (const row of results) {
  const diff = join(rescore, `${row.id}.diff`);
  row.verdict = existsSync(diff) ? score(cases[row.name], readFileSync(diff, "utf8")) : row.verdict;
}
for (const name of rescore === null ? selected : []) {
  const spec = cases[name];
  if (spec === undefined) throw new Error(`unknown case ${name}`);
  for (const cond of ["A", "B"])
    for (let rep = 1; rep <= reps; rep++) {
      const id = `${name}-${cond}-${rep}`;
      const dir = join(out, id);
      cpSync(join(here, "cases", name), dir, { recursive: true });
      const git = (...a) => execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid", ...a], { cwd: dir });
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "case");

      const crashed = spawnSync(spec.run[0], spec.run.slice(1), { cwd: dir, encoding: "utf8" });
      const relative = (text) => text.replaceAll(`${dir}/`, "./");
      const error = relative(crashed.stderr || crashed.stdout);
      let prompt = `My program crashed. Here is the error output:\n\n\`\`\`\n${error.trim()}\n\`\`\`\n`;
      if (cond === "B") {
        const report = spawnSync(process.execPath, [cli, "-", "--source", dir], { input: crashed.stderr, encoding: "utf8" });
        prompt += `\nHere is the crashlens report for this crash:\n\n\`\`\`markdown\n${relative(report.stdout).trim()}\n\`\`\`\n`;
      }
      prompt += "\nFix the bug. Edit the code directly; do not run anything.\n";
      writeFileSync(`${dir}.prompt.txt`, prompt);

      const agent = spawnSync(
        "claude",
        ["-p", prompt, ...(model === "" ? [] : ["--model", model]), "--allowedTools", "Read,Edit,Glob,Grep", "--permission-mode", "acceptEdits", "--output-format", "json"],
        { cwd: dir, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 },
      );
      writeFileSync(`${dir}.json`, agent.stdout ?? "");
      const diff = execFileSync("git", ["diff"], { cwd: dir, encoding: "utf8" });
      writeFileSync(`${dir}.diff`, diff);
      let metrics = {};
      try {
        metrics = JSON.parse(agent.stdout);
      } catch {}
      const row = { id, name, cond, model: model || "default", verdict: score(spec, diff), turns: metrics.num_turns, ms: metrics.duration_ms, usd: metrics.total_cost_usd };
      results.push(row);
      console.log(`${id}: ${row.verdict} (${row.turns ?? "?"} turns, ${((row.ms ?? 0) / 1000).toFixed(1)}s, $${(row.usd ?? 0).toFixed(4)})`);
    }
}

/**
 * From the diff's added lines per file: "root" when a root pattern matches in
 * its file (a clear error for bad input beside it is fine), "symptom" when only
 * a guard or default matches, "other" for anything else, "none" for no edit.
 */
function score(spec, diff) {
  const added = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.*)$/.exec(line);
    if (header !== null) file = header[1];
    else if (file !== null && line.startsWith("+")) added.set(file, `${added.get(file) ?? ""}${line.slice(1)}\n`);
  }
  if (added.size === 0) return "none";
  const root = spec.root.some((r) => new RegExp(r.pattern).test(added.get(r.file) ?? ""));
  const symptom = [...added.values()].some((text) => new RegExp(spec.symptom).test(text));
  return root ? "root" : symptom ? "symptom" : "other";
}

const names = [...new Set(results.map((r) => r.name))];
const table = ["| Case | A root | B root | A symptom | B symptom | A turns | B turns | A s | B s | A $ | B $ |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
const mean = (rows, key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0) / Math.max(rows.length, 1);
for (const name of names) {
  const a = results.filter((r) => r.name === name && r.cond === "A");
  const b = results.filter((r) => r.name === name && r.cond === "B");
  const count = (rows, ...v) => `${rows.filter((r) => v.includes(r.verdict)).length}/${rows.length}`;
  table.push(
    `| ${name} | ${count(a, "root")} | ${count(b, "root")} | ${count(a, "symptom")} | ${count(b, "symptom")} | ${mean(a, "turns").toFixed(1)} | ${mean(b, "turns").toFixed(1)} | ${(mean(a, "ms") / 1000).toFixed(1)} | ${(mean(b, "ms") / 1000).toFixed(1)} | ${mean(a, "usd").toFixed(4)} | ${mean(b, "usd").toFixed(4)} |`,
  );
}
const summary = `# crashlens A/B benchmark\n\nModel: ${model || (rescore === null ? "default" : "see results.json")}; ${reps} run(s) per cell. A = error output only, B = error output + crashlens report.\n"root" counts diffs that fix the cause, "symptom" those that only guard the crash site; read the diffs in this folder before quoting.\n\n${table.join("\n")}\n`;
writeFileSync(join(out, "summary.md"), summary);
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n${summary}\nRuns and diffs: ${out}`);
