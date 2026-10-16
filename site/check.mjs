// Checks the browser bundle against the Node pipeline on every captured
// fixture: same parse, same classification, same report, same signature.
// Run after `npm run build && node site/build.mjs`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parseFailure } from "../dist/src/failure.js";
import { toFailureIssue } from "../dist/src/failureIssue.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const context = { TextEncoder };
vm.createContext(context);
vm.runInContext(`${readFileSync(join(root, "site/dist/crashlens.js"), "utf8")};this.crashlens = crashlens;`, context);

let checked = 0;
for (const dir of ["failures", "panics"]) {
  for (const file of readdirSync(join(root, "test/fixtures", dir))) {
    const text = readFileSync(join(root, "test/fixtures", dir, file), "utf8");
    const parsed = parseFailure(text);
    const browser = context.crashlens.analyze(text, file);
    const node = parsed.ok ? toFailureIssue(parsed.value, file, text) : null;
    if (!browser.ok || JSON.stringify(browser.issue) !== JSON.stringify(node)) {
      console.error(`browser and Node reports differ for ${dir}/${file}`);
      process.exit(1);
    }
    checked++;
  }
}
console.log(`browser bundle matches Node on ${checked} fixtures`);
