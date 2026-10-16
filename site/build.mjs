// Builds the static demo site into site/dist from the real web UI.
// Run after `npm run build`:  node site/build.mjs
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_CSS, APP_JS, INDEX_HTML } from "../dist/src/web/page.js";

const site = dirname(fileURLToPath(import.meta.url));
const out = join(site, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The text pipeline, bundled for the browser with tiny node:* stand-ins.
await build({
  entryPoints: [join(site, "browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "crashlens",
  platform: "browser",
  target: "es2020",
  minify: true,
  alias: { "node:crypto": join(site, "shims/crypto.ts"), "node:path": join(site, "shims/path.ts") },
  outfile: join(out, "crashlens.js"),
  logLevel: "warning",
});

const REPO = "https://github.com/mingleiw/crashlens";
const banner = `<div class="demo-bar">
  <b>Live demo</b>: the sample bugs below are real crashlens reports. Paste your own Python, Java, Node, Go or Rust stack trace, or an ASan report: it is analyzed right here in your browser and never uploaded.
  <a href="${REPO}#install">Get crashlens</a> for core dumps, your source code and live log watching.
</div>`;

const html = INDEX_HTML
  // Project pages live under /crashlens/, so assets must be relative.
  .replace('href="/app.css"', 'href="app.css"')
  .replace('<script src="/app.js" defer></script>', '<script src="crashlens.js" defer></script>\n<script src="demo.js" defer></script>\n<script src="app.js" defer></script>')
  .replace("<title>crashlens</title>", `<title>crashlens: live demo</title>
<meta name="description" content="Find out why your program crashed. Paste a stack trace or panic and get a readable bug report, right in your browser.">
<meta property="og:title" content="crashlens: why did it crash?">
<meta property="og:description" content="Paste a stack trace, panic or sanitizer report and get a readable bug report. Runs in your browser.">
<link rel="icon" href="data:,">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">`)
  .replace('<main class="layout">', `${banner}\n<main class="layout">`)
  .replace('<div class="local" title="Files are processed by the crashlens process on this computer">Runs locally · nothing leaves this machine</div>', `<a class="local" href="${REPO}">Runs in your browser · open source on GitHub</a>`);

const demoCss = `
.demo-bar { max-width: 1500px; margin: 16px 16px 0; padding: 10px 16px; border: 1px solid var(--accent); border-radius: 10px; background: var(--accent-soft); font-size: 14px; }
.demo-bar a { color: var(--accent); font-weight: 600; }
@media (min-width: 861px) { .demo-bar { margin-left: 24px; margin-right: 24px; } }
@media (min-width: 1548px) { .demo-bar { margin-left: auto; margin-right: auto; } }
a.local { text-decoration: none; }
#sourceCard { display: none; }
`;

writeFileSync(join(out, "index.html"), html);
writeFileSync(join(out, "app.css"), APP_CSS + demoCss);
writeFileSync(join(out, "app.js"), APP_JS);
copyFileSync(join(site, "demo.js"), join(out, "demo.js"));
copyFileSync(join(site, "demo-data.json"), join(out, "demo-data.json"));
writeFileSync(join(out, ".nojekyll"), "");
console.log("built site/dist");
