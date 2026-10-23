import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { parseFailure } from "../src/failure.js";
import { toFailureIssue } from "../src/failureIssue.js";
import { renderIssueMarkdown } from "../src/issue.js";
import { nativeHypotheses } from "../src/nativeHints.js";
import { attachSource } from "../src/source.js";
import type { TriageReport } from "../src/triage.js";

const work = mkdtempSync(join(tmpdir(), "crashlens-trace-"));
after(() => rmSync(work, { recursive: true, force: true }));

function project(name: string, files: Record<string, string[]>): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), lines.join("\n"));
  }
  return dir;
}

async function report(root: string, output: string): Promise<string> {
  const parsed = parseFailure(output);
  assert.ok(parsed.ok);
  return renderIssueMarkdown(await attachSource(toFailureIssue(parsed.value, "err", output), root));
}

function hypotheses(markdown: string): string {
  return /## Hypotheses to check first\n\n([\s\S]*?)\n## /.exec(markdown)?.[1] ?? "";
}

describe("value trace", () => {
  it("names a missing await on an async producer in another file", async () => {
    const root = project("await", {
      "db.js": ["const rows = { 7: { name: 'Ada' } };", "", "async function getUser(id) {", "  return rows[id];", "}", "", "module.exports = { getUser };"],
      "format.js": ["function badge(user) {", "  return user.name.toUpperCase();", "}", "module.exports = { badge };"],
      "handler.js": ["const { getUser } = require('./db');", "const { badge } = require('./format');", "", "async function profile(req) {", "  const user = getUser(req.id);", "  return badge(user);", "}", "profile({ id: 7 });"],
    });
    const md = await report(root, [
      "TypeError: Cannot read properties of undefined (reading 'toUpperCase')",
      `    at badge (${root}/format.js:2:20)`,
      `    at profile (${root}/handler.js:6:10)`,
      `    at Object.<anonymous> (${root}/handler.js:8:1)`,
      "    at Module._compile (node:internal/modules/cjs/loader:1706:14)",
      "    at Object..js (node:internal/modules/cjs/loader:1839:10)",
      "    at Module.load (node:internal/modules/cjs/loader:1441:32)",
    ].join("\n"));
    assert.match(hypotheses(md), /Missing `await`.*`getUser` is `async`.*handler\.js:5/);
    assert.match(md, /`user` is a parameter of `badge`, passed as `user` at `handler\.js:6`/);
    assert.match(md, /## Code: db\.js:3 \(getUser\)/);
    assert.match(md, /… 2 more frames in runtime or library code/);
    assert.doesNotMatch(md, new RegExp(`${root}/`), "paths under the source root are shortened");
    assert.doesNotMatch(md, /Handle the missing case/);
  });

  it("flags a lookup that found nothing and a key that differs only in case", async () => {
    const root = project("case", {
      "server.js": [
        'const users = [{ id: "u1", name: "Ada" }];',
        "function findUser(id) {",
        "  return users.find((u) => u.id === id);",
        "}",
        "function greeting(user) {",
        '  return "Hello, " + user.name;',
        "}",
        "function handle(req) {",
        "  const user = findUser(req.userId);",
        "  return greeting(user);",
        "}",
        'handle({ userId: "U1" });',
      ],
    });
    const md = await report(root, [
      "TypeError: Cannot read properties of undefined (reading 'name')",
      `    at greeting (${root}/server.js:6:29)`,
      `    at handle (${root}/server.js:10:10)`,
      `    at Object.<anonymous> (${root}/server.js:12:1)`,
    ].join("\n"));
    const h = hypotheses(md);
    assert.match(h, /lookup found nothing.*`findUser`/);
    assert.match(h, /case mismatch.*"U1".*server\.js:12.*"u1".*server\.js:1/);
  });

  it("finds the dict built with a different key name across a queue", async () => {
    const root = project("queue", {
      "api.py": ["def create(req):", "    job = {", '        "job_id": req["id"],', '        "customer": req["customer_id"],', '        "amount_cents": 5,', "    }", "    publish(job)"],
      "worker.py": [
        "def receipt(job):",
        '    return "%s %s" % (job["customer_id"], job["amount_cents"])',
        "",
        "def handle(job):",
        '    print(job["job_id"])',
        "    print(receipt(job))",
        "",
        "def run():",
        "    for job in consume():",
        "        handle(job)",
      ],
    });
    const md = await report(root, [
      "Traceback (most recent call last):",
      `  File "${root}/worker.py", line 10, in run`,
      "    handle(job)",
      `  File "${root}/worker.py", line 6, in handle`,
      "    print(receipt(job))",
      `  File "${root}/worker.py", line 2, in receipt`,
      '    return "%s %s" % (job["customer_id"], job["amount_cents"])',
      "KeyError: 'customer_id'",
    ].join("\n"));
    assert.match(hypotheses(md), /Field name mismatch.*`api\.py:2`.*`job_id`, `amount_cents`.*no `customer_id`; it has `customer` instead/);
    assert.match(md, /`job` is an element of `consume\(\)` \(`worker\.py:9`\)/);
    assert.doesNotMatch(md, /Use `\.get\(key\)` with a default, or/);
  });

  it("traces an operand type error to a setting read from the environment", async () => {
    const root = project("config", {
      "settings.py": ["import os", 'TIMEOUT = os.environ.get("TIMEOUT", "30")'],
      "retry.py": ["import settings", "def deadline(start):", "    return start + settings.TIMEOUT"],
    });
    const md = await report(root, [
      "Traceback (most recent call last):",
      `  File "${root}/retry.py", line 3, in deadline`,
      "    return start + settings.TIMEOUT",
      "TypeError: unsupported operand type(s) for +: 'float' and 'str'",
    ].join("\n"));
    assert.match(hypotheses(md), /`settings\.TIMEOUT` comes from the environment.*settings\.py:2.*always a string/);
  });

  it("follows a lookup key across files to the literal that does not match", async () => {
    const root = project("currency", {
      "config.js": ['module.exports = { currency: "eur" };'],
      "rates.js": ['const RATES = new Map([["EUR", { value: 0.9 }]]);', "module.exports = { RATES };"],
      "convert.js": ['const { RATES } = require("./rates");', "function convert(usd, currency) {", "  return usd * RATES.get(currency).value;", "}", "module.exports = { convert };"],
      "cart.js": ['const settings = require("./config");', 'const { convert } = require("./convert");', "function total(usd) {", "  return convert(usd, settings.currency);", "}", "total(3);"],
    });
    const md = await report(root, [
      "TypeError: Cannot read properties of undefined (reading 'value')",
      `    at convert (${root}/convert.js:3:36)`,
      `    at total (${root}/cart.js:4:10)`,
      `    at Object.<anonymous> (${root}/cart.js:6:1)`,
    ].join("\n"));
    assert.match(md, /The lookup key is `"eur"` \(`settings\.currency`\), set at `config\.js:1`/);
    assert.match(hypotheses(md), /case mismatch.*"eur".*config\.js:1.*"EUR".*rates\.js:1/);
  });

  it("spots columns zipped against a shifted slice, through a generator expression", async () => {
    const root = project("csv", {
      "loader.py": ["def load(lines):", "    header = lines[0]", "    return [dict(zip(header, v[1:])) for v in lines[1:]]"],
      "report.py": ["def line(row):", '    return row["qty"]', "", "def summary(rows):", "    return sum(line(r) for r in rows)"],
      "main.py": ["import loader, report", 'rows = loader.load([["sku", "qty"], ["a", 2]])', "report.summary(rows)"],
    });
    const md = await report(root, [
      "Traceback (most recent call last):",
      `  File "${root}/main.py", line 3, in <module>`,
      "    report.summary(rows)",
      `  File "${root}/report.py", line 5, in summary`,
      "    return sum(line(r) for r in rows)",
      `  File "${root}/report.py", line 5, in <genexpr>`,
      "    return sum(line(r) for r in rows)",
      `  File "${root}/report.py", line 2, in line`,
      '    return row["qty"]',
      "KeyError: 'qty'",
    ].join("\n"));
    assert.match(md, /`rows` is assigned at `main\.py:2`/);
    assert.match(hypotheses(md), /Columns shifted.*`zip\(header, v\[1:\]\)` at `loader\.py:3`.*`qty`/);
    assert.doesNotMatch(md, /lookup key/);
  });

  it("names the payload key a model reads under the wrong name", async () => {
    const files = {
      "fixtures/order.json": ['{"orderId": "o-1", "shippingAddress": {"line1": "1 Main St"}}'],
      "models.py": [
        "class Order:",
        "    def __init__(self, id, address):",
        "        self.id = id",
        "        self.address = address",
        "    @classmethod",
        "    def from_payload(cls, payload):",
        '        return cls(id=payload.get("orderId"), address=payload.get("shipping_address"))',
      ],
      "app.py": ["import json", "from models import Order", "def label(order):", "    return order.address['line1']", "order = Order.from_payload(json.load(open('fixtures/order.json')))", "label(order)"],
    };
    const trace = (root: string) => [
      "Traceback (most recent call last):",
      `  File "${root}/app.py", line 6, in <module>`,
      "    label(order)",
      `  File "${root}/app.py", line 4, in label`,
      "    return order.address['line1']",
      "TypeError: 'NoneType' object is not subscriptable",
    ].join("\n");
    const root = project("payload", files);
    const md = await report(root, trace(root));
    assert.match(hypotheses(md), /Field name mismatch.*`address` is read from `payload\.get\("shipping_address"\)` at `models\.py:7`.*no data sample in the project has `shipping_address`; it has `shippingAddress` \(`fixtures\/order\.json:1`\)/);
    assert.doesNotMatch(md, /lookup found nothing/, "the order exists; only its field is missing");

    // The key is in the data (just empty this time): no mismatch to report.
    const present = project("payload-present", { ...files, "fixtures/order.json": ['{"orderId": "o-1", "shipping_address": null}'] });
    assert.doesNotMatch(await report(present, trace(present)), /Field name mismatch/);
    // No sample of the data in the repo: nothing to compare with, so say nothing.
    const { ["fixtures/order.json"]: _sample, ...withoutSample } = files;
    const unknown = project("payload-unknown", withoutSample);
    assert.doesNotMatch(await report(unknown, trace(unknown)), /Field name mismatch/);
  });

  it("follows a field set in a JS constructor and a chained call split over lines", async () => {
    const root = project("payload-js", {
      "fixtures/user.json": ['{ "id": 3, "display_name": "Ada" }'],
      "user.js": ["class User {", "  constructor(raw) {", "    this.id = raw.id;", "    this.displayName = raw.displayName;", "  }", "}", "module.exports = { User };"],
      "app.js": [
        'const { User } = require("./user");',
        "function initials(user) {",
        "  return user.displayName",
        '    .split(" ")',
        "    .join(\"\");",
        "}",
        'initials(new User(require("./fixtures/user.json")));',
      ],
    });
    const md = await report(root, [
      "TypeError: Cannot read properties of undefined (reading 'split')",
      `    at initials (${root}/app.js:4:6)`,
      `    at Object.<anonymous> (${root}/app.js:7:1)`,
    ].join("\n"));
    assert.match(md, /The bad value is `user\.displayName`/);
    assert.match(hypotheses(md), /`displayName` is read from `raw\.displayName` at `user\.js:4`.*`display_name`/);
  });

  it("reads pytest --showlocals output and shows the expected key next to the real value", async () => {
    const root = project("pytest-locals", {
      "receipts.py": ["def receipt_line(order):", '    customer = order.get("customer_id")', "    return customer.upper()"],
      "test_r.py": ["from receipts import receipt_line", "def test_r():", '    assert receipt_line({"customerId": "c-7"})'],
    });
    const out = [
      "=================================== FAILURES ===================================",
      "____________________________________ test_r ____________________________________",
      "",
      "    def test_r():",
      '>       assert receipt_line({"customerId": "c-7"})',
      "",
      "",
      "test_r.py:3: ",
      "_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ ",
      "",
      "order = {'customerId': 'c-7', 'apiToken': 'sk-live-4f9a2c1e9b'}",
      "",
      "    def receipt_line(order):",
      '        customer = order.get("customer_id")',
      ">       return customer.upper()",
      "E       AttributeError: 'NoneType' object has no attribute 'upper'",
      "",
      "customer   = None",
      "order      = {'customerId': 'c-7', 'apiToken': 'sk-live-4f9a2c1e9b'}",
      "",
      "receipts.py:3: AttributeError",
      "=========================== short test summary info ============================",
    ].join("\n");
    const md = await report(root, out);
    assert.match(md, /Value was None in `receipt_line`/);
    assert.match(hypotheses(md), /Runtime value: wrong key.*`order\.get\("customer_id"\)`.*it has `customerId`, not `customer_id`/);
    assert.doesNotMatch(md, /sk-live/, "credentials in locals are masked");
    assert.match(md, /'apiToken': '\*\*\*'/);
  });

  it("reads a Sentry event and its frame variables", async () => {
    const root = project("sentry", { "mapper.js": ["function toProfile(body) {", '  return body.userName.split(" ");', "}"] });
    const event = JSON.stringify({
      platform: "node",
      exception: { values: [{ type: "TypeError", value: "Cannot read properties of undefined (reading 'split')", stacktrace: { frames: [
        { abs_path: "/srv/app/mapper.js", function: "toProfile", lineno: 2, colno: 24, in_app: true, vars: { body: { user_name: "Ada", password: "hunter2" } } },
      ] } }] },
    });
    const md = await report(root, event);
    assert.match(hypotheses(md), /`body\.userName`.*it has `user_name`, not `userName`/);
    assert.doesNotMatch(md, /hunter2/);
  });

  it("lets runtime values decide, and flags when the run and a repo sample disagree", async () => {
    const pytestOut = (order: string) =>
      [
        "____________________________________ test_r ____________________________________",
        "",
        `order = ${order}`,
        "",
        "    def receipt_line(order):",
        '        customer = order.get("customer_id")',
        ">       return customer.upper()",
        "E       AttributeError: 'NoneType' object has no attribute 'upper'",
        "",
        "customer   = None",
        `order      = ${order}`,
        "",
        "receipts.py:3: AttributeError",
      ].join("\n");
    const code = { "receipts.py": ["def receipt_line(order):", '    customer = order.get("customer_id")', "    return customer.upper()"] };

    // The run had the key (empty); a stale fixture spells it differently: no name mismatch claimed.
    const stale = project("conflict-stale", { ...code, "fixtures/order.json": ['{"customerId": "c-7"}'] });
    const staleMd = hypotheses(await report(stale, pytestOut("{'customer_id': None}")));
    assert.doesNotMatch(staleMd, /wrong key|Field name mismatch/);
    assert.match(staleMd, /The run and the repo disagree.*had `customer_id`, but the sample at `fixtures\/order\.json:1` spells it `customerId`/);

    // The run lacks the key the fixture has: the runtime value leads, and the disagreement is noted.
    const changed = project("conflict-changed", { ...code, "fixtures/order.json": ['{"customer_id": "c-7"}'] });
    const changedMd = hypotheses(await report(changed, pytestOut("{'customerId': 'c-7'}")));
    assert.match(changedMd, /^- \*\*Runtime value: wrong key\.\*\*/);
    assert.match(changedMd, /The run and the repo disagree.*had `customerId`, but the sample at `fixtures\/order\.json:1` has `customer_id`/);

    // The object exists with an empty field: that does not contradict the static finding
    // that its constructor read a key the data spells differently, so that finding stays.
    const field = project("conflict-field", {
      "fixtures/order.json": ['{"orderId": "o-1", "shippingAddress": {"line1": "x"}}'],
      "models.py": [
        "class Order:",
        "    def __init__(self, id, address):",
        "        self.id = id",
        "        self.address = address",
        "    @classmethod",
        "    def from_payload(cls, payload):",
        '        return cls(id=payload.get("orderId"), address=payload.get("shipping_address"))',
      ],
      "labels.py": ["def label(order):", "    return order.address['line1']"],
      "test_app.py": ["import json", "from models import Order", "from labels import label", "def test_label():", "    order = Order.from_payload(json.load(open('fixtures/order.json')))", "    label(order)"],
    });
    const fieldMd = hypotheses(
      await report(
        field,
        [
          "____________________________________ test_label ____________________________________",
          "",
          "    def test_label():",
          "        order = Order.from_payload(json.load(open('fixtures/order.json')))",
          ">       label(order)",
          "",
          "test_app.py:6: ",
          "_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ ",
          "",
          "    def label(order):",
          ">       return order.address['line1']",
          "E       TypeError: 'NoneType' object is not subscriptable",
          "",
          "order      = Order(id='o-1', address=None)",
          "",
          "labels.py:2: TypeError",
        ].join("\n"),
      ),
    );
    assert.match(fieldMd, /Field name mismatch.*`address` is read from `payload\.get\("shipping_address"\)`/);

    // They agree: no conflict note.
    const agree = project("conflict-agree", { ...code, "fixtures/order.json": ['{"customerId": "c-7"}'] });
    assert.doesNotMatch(hypotheses(await report(agree, pytestOut("{'customerId': 'c-7'}"))), /disagree/);
  });

  it("uses the evaluated key from a KeyError when the code computes the key", async () => {
    const root = project("dynkey", {
      "importer.py": ["def load():", '    return [{"account": "acme", "kind": "billing", "billing_reference": "BL-1", "amount": 5}]'],
      "refs.py": ["def reference_for(record, prefix):", '    return record[prefix + "_ref"]'],
      "ledger.py": [
        "from refs import reference_for",
        "def line(record):",
        '    ref = reference_for(record, record["kind"])',
        "    return record['account'] + ref + str(record['amount'])",
      ],
    });
    const md = await report(root, [
      "Traceback (most recent call last):",
      `  File "${root}/ledger.py", line 3, in line`,
      '    ref = reference_for(record, record["kind"])',
      `  File "${root}/refs.py", line 2, in reference_for`,
      '    return record[prefix + "_ref"]',
      "KeyError: 'billing_ref'",
    ].join("\n"));
    assert.match(md, /The key is computed: `prefix \+ "_ref"` evaluated to `'billing_ref'`/);
    assert.match(hypotheses(md), /Field name mismatch.*no `billing_ref`; it has `billing_reference` instead/);
  });

  it("compares a computed key with the runtime value from pytest --showlocals", async () => {
    const root = project("dynkey-locals", { "cfg.py": ["def url(cfg, env):", '    return cfg[f"{env}_url"]'] });
    const md = await report(root, [
      "____________________________________ test_url ____________________________________",
      "",
      "    def url(cfg, env):",
      '>       return cfg[f"{env}_url"]',
      "E       KeyError: 'prod_url'",
      "",
      "cfg        = {'PROD_URL': 'https://api', 'staging_url': 'https://stg'}",
      "env        = 'prod'",
      "",
      "cfg.py:2: KeyError",
    ].join("\n"));
    assert.match(hypotheses(md), /Runtime value: wrong key.*reads `cfg\[f"\{env\}_url"\]`.*it has `PROD_URL`, not `prod_url`/);
  });

  it("stays silent when several computed subscripts could have raised the KeyError", async () => {
    const root = project("dynkey-ambiguous", { "a.py": ["def f(a, b, x, y):", "    return a[x] + b[y]"] });
    const md = await report(root, [
      "Traceback (most recent call last):",
      `  File "${root}/a.py", line 2, in f`,
      "    return a[x] + b[y]",
      "KeyError: 'k'",
    ].join("\n"));
    assert.doesNotMatch(md, /The key is computed|## Hypotheses/);
  });

  describe("config objects built by a merge", () => {
    it("survives a deeply nested config literal", async () => {
      // One brace per line: long lines are ignored, so this is the shape a crafted file would use.
      const deep = `module.exports = { db:\n${"{ a:\n".repeat(120000)}1\n${"}\n".repeat(120000)}};`;
      const root = project("merge-nested", {
        "defaults.js": [deep],
        "production.js": ["module.exports = { db: {} };"],
        "config.js": ['const defaults = require("./defaults");', "function loadConfig() {", '  const overrides = require("./production");', "  return Object.assign({}, defaults, overrides);", "}", "module.exports = { loadConfig };"],
        "pool.js": ["function createPool(dbConfig) {", "  return dbConfig.pool.max;", "}", "module.exports = { createPool };"],
        "server.js": ['const { loadConfig } = require("./config");', 'const { createPool } = require("./pool");', "createPool(loadConfig().db);"],
      });
      const md = await report(root, [
        "TypeError: Cannot read properties of undefined (reading 'max')",
        `    at createPool (${root}/pool.js:2:23)`,
        `    at Object.<anonymous> (${root}/server.js:3:1)`,
      ].join("\n"));
      assert.match(md, /The bad value is `dbConfig\.pool`/);
    });

    const jsCrash = (root: string) =>
      [
        "TypeError: Cannot read properties of undefined (reading 'max')",
        `    at createPool (${root}/pool.js:2:23)`,
        `    at Object.<anonymous> (${root}/server.js:3:1)`,
      ].join("\n");
    const jsProject = (name: string, merge: string, override: string, extra: Record<string, string[]> = {}) =>
      project(name, {
        "defaults.js": ["module.exports = {", "  db: { host: 'localhost', pool: { max: 10 } },", "};"],
        "production.js": ["module.exports = {", `  ${override}`, "};"],
        "config.js": ['const defaults = require("./defaults");', "function loadConfig(env) {", '  const overrides = env === "production" ? require("./production") : {};', `  return ${merge};`, "}", "module.exports = { loadConfig };"],
        "pool.js": ["function createPool(dbConfig) {", "  return dbConfig.pool.max;", "}", "module.exports = { createPool };"],
        "server.js": ['const { loadConfig } = require("./config");', 'const { createPool } = require("./pool");', 'createPool(loadConfig("production").db);'],
        ...extra,
      });

    it("names the nested key a shallow Object.assign or spread drops, through config.db", async () => {
      for (const merge of ["Object.assign({}, defaults, overrides)", "{ ...defaults, ...overrides }"]) {
        const root = jsProject(`merge-${merge.length}`, merge, "db: { host: 'db.internal' },");
        const md = await report(root, jsCrash(root));
        assert.match(hypotheses(md), /^- \*\*Shallow merge drops a nested key\.\*\*.*`production\.js:2` sets `db` without `pool`, so `db\.pool` from `defaults\.js:2` is lost/);
      }
    });

    it("handles Python {**a, **b} and dict.update with subscripted config", async () => {
      for (const merge of ["{**defaults.DEFAULTS, **overrides}", "dict(defaults.DEFAULTS, **overrides)"]) {
        const root = project(`py-merge-${merge.length}`, {
          "defaults.py": ['DEFAULTS = {"cache": {"backend": "memory", "ttl": 300}}'],
          "prod.py": ['OVERRIDES = {"cache": {"backend": "redis"}}'],
          "config.py": ["import defaults", "import prod", "def load():", "    overrides = prod.OVERRIDES", `    return ${merge}`],
          "app.py": ["import config", "def make(cfg):", '    return cfg["ttl"]', 'make(config.load()["cache"])'],
        });
        const md = await report(root, [
          "Traceback (most recent call last):",
          `  File "${root}/app.py", line 4, in <module>`,
          '    make(config.load()["cache"])',
          `  File "${root}/app.py", line 3, in make`,
          '    return cfg["ttl"]',
          "KeyError: 'ttl'",
        ].join("\n"));
        assert.match(hypotheses(md), /Shallow merge drops a nested key.*`prod\.py:1` sets `cache` without `ttl`, so `cache\.ttl` from `defaults\.py:1` is lost/, merge);
      }
    });

    it("stays silent for a deep merge, an override that keeps the key, a top-level key, or a source it cannot see", async () => {
      const deep = jsProject("merge-deep", "deepMerge(defaults, overrides)", "db: { host: 'db.internal' },", {
        "config.js": ['const defaults = require("./defaults");', "function deepMerge(a, b) { return a; }", "function loadConfig(env) {", '  const overrides = env === "production" ? require("./production") : {};', "  return deepMerge(defaults, overrides);", "}", "module.exports = { loadConfig };"],
      });
      assert.doesNotMatch(await report(deep, jsCrash(deep)), /Shallow merge/);
      const kept = jsProject("merge-kept", "Object.assign({}, defaults, overrides)", "db: { host: 'db.internal', pool: { max: 50 } },");
      assert.doesNotMatch(await report(kept, jsCrash(kept)), /Shallow merge/);
      const runtime = jsProject("merge-runtime", "Object.assign({}, defaults, overrides)", "db: { host: 'db.internal' },", {
        "config.js": ['const defaults = require("./defaults");', 'const fs = require("fs");', "function loadConfig(env) {", '  const overrides = JSON.parse(fs.readFileSync(env + ".json", "utf8"));', "  return Object.assign({}, defaults, overrides);", "}", "module.exports = { loadConfig };"],
      });
      assert.doesNotMatch(await report(runtime, jsCrash(runtime)), /Shallow merge/);
      // `config.db` itself missing: a shallow merge keeps top-level keys, so it is not the cause.
      const top = jsProject("merge-top", "Object.assign({}, defaults, overrides)", "log: { level: 'warn' },", {
        "pool.js": ["function createPool(config) {", "  return config.cache.max;", "}", "module.exports = { createPool };"],
        "server.js": ['const { loadConfig } = require("./config");', 'const { createPool } = require("./pool");', 'createPool(loadConfig("production"));'],
      });
      assert.doesNotMatch(await report(top, jsCrash(top)), /Shallow merge/);
    });
  });

  it("adds nothing when the source gives no lead", async () => {
    const root = project("plain", { "a.py": ["def f(x):", "    return x.name", "f(None)"] });
    const md = await report(root, [
      "Traceback (most recent call last):",
      `  File "${root}/a.py", line 3, in <module>`,
      "    f(None)",
      `  File "${root}/a.py", line 2, in f`,
      "    return x.name",
      "AttributeError: 'NoneType' object has no attribute 'name'",
    ].join("\n"));
    assert.doesNotMatch(md, /## Hypotheses/);
    assert.match(md, /`x` is a parameter of `f`, passed as `None` at `a\.py:3`/);
  });
});

describe("Java NullPointerException trace", () => {
  const npe = (message: string, ...frames: string[]) =>
    [`Exception in thread "main" java.lang.NullPointerException: ${message}`, ...frames.map((f) => `\tat ${f}`)].join("\n");
  const P = "src/main/java/app";

  it("maps <localN> to the variable by slot, past a long parameter and a closed block", async () => {
    const root = project("java-slot", {
      [`${P}/Account.java`]: ["package app;", "", "public record Account(String code, String name) {}"],
      [`${P}/Ledger.java`]: [
        "package app;",
        "",
        "import java.util.HashMap;",
        "import java.util.Map;",
        "",
        "public class Ledger {",
        "    private final Map<String, Account> accounts = new HashMap<>();",
        "",
        "    public void open(Account a) { accounts.put(a.code().trim(), a); }",
        "",
        "    public Account lookup(String code) { return accounts.get(code); }",
        "",
        "    public static String describe(Ledger ledger, long stamp, String code) {",
        "        for (int i = 0; i < 2; i++) {",
        '            String ignored = "x" + i;',
        "        }",
        "        Account account = ledger.lookup(code);",
        "        return account.name() + stamp;",
        "    }",
        "}",
      ],
    });
    const md = await report(root, npe('Cannot invoke "app.Account.name()" because "<local4>" is null', "app.Ledger.describe(Ledger.java:18)", "app.Main.main(Main.java:5)"));
    assert.match(md, /`<local4>` in the message is the local variable `account`/);
    assert.match(md, /`account` is assigned `ledger\.lookup\(code\)` at `src\/main\/java\/app\/Ledger\.java:17`/);
    assert.match(hypotheses(md), /^- \*\*Key normalized on write, not on read\.\*\* `src\/main\/java\/app\/Ledger\.java:9` stores entries under `a\.code\(\)\.trim\(\)`.*without `trim\(\)`/);
  });

  it("counts every declarator in `String a = \"a\", b = null;` and multi-catch variables", async () => {
    const root = project("java-slot-multi", {
      [`${P}/Pair.java`]: [
        "package app;",
        "",
        "public class Pair {",
        "    public static int run(int x) {",
        "        try {",
        "            Integer.parseInt(\"1\");",
        "        } catch (IllegalStateException | NumberFormatException e) {",
        "            System.out.println(e);",
        "        }",
        "        String a = \"a\", b = null;",
        "        return a.length() + b.length() + x;",
        "    }",
        "}",
      ],
    });
    // javac: x = 0, the catch variable reuses slot 1 and is freed, a = 1, b = 2.
    const md = await report(root, npe('Cannot invoke "String.length()" because "<local2>" is null', "app.Pair.run(Pair.java:11)"));
    assert.match(md, /`<local2>` in the message is the local variable `b`/);
    assert.match(hypotheses(md), /Assigned null\.\*\* `b` is set to `null` at `src\/main\/java\/app\/Pair\.java:10`/);
  });

  it("says nothing about a slot whose variable has the wrong type", async () => {
    const root = project("java-slot-type", {
      [`${P}/Report.java`]: ["package app;", "", "public class Report {", "    public static int size(String title) {", "        String body = load(title);", "        return body.length();", "    }", "    static String load(String t) { return t; }", "}"],
    });
    const md = await report(root, npe('Cannot invoke "app.Customer.tier()" because "<local1>" is null', "app.Report.size(Report.java:6)"));
    assert.doesNotMatch(md, /in the message is the local variable/);
    assert.equal(hypotheses(md), "");
  });

  it("follows a parameter to the caller that passed null, and reads a method that returns null", async () => {
    const root = project("java-null-arg", {
      [`${P}/Mailer.java`]: ["package app;", "", "public class Mailer {", "    public String subject(String user) {", "        return user.toUpperCase();", "    }", "}"],
      [`${P}/Directory.java`]: [
        "package app;",
        "",
        "public class Directory {",
        "    public String owner(String team) {",
        '        if (team.equals("ops")) {',
        '            return "dana";',
        "        }",
        "        return null;",
        "    }",
        "}",
      ],
      [`${P}/Main.java`]: [
        "package app;",
        "",
        "public class Main {",
        "    public static void main(String[] args) {",
        "        Directory directory = new Directory();",
        "        Mailer mailer = new Mailer();",
        "        String user = null;",
        "        System.out.println(mailer.subject(user));",
        '        String owner = directory.owner("billing");',
        "        System.out.println(mailer.subject(owner));",
        "    }",
        "}",
      ],
    });
    const fromLiteral = await report(root, npe('Cannot invoke "String.toUpperCase()" because "<local1>" is null', "app.Mailer.subject(Mailer.java:5)", "app.Main.main(Main.java:8)"));
    assert.match(fromLiteral, /`user` is a parameter of `subject`, passed as `user` at `src\/main\/java\/app\/Main\.java:8`/);
    assert.match(hypotheses(fromLiteral), /^- \*\*Assigned null\.\*\* `user` is set to `null` at `src\/main\/java\/app\/Main\.java:7`/);
    const fromMethod = await report(root, npe('Cannot invoke "String.toUpperCase()" because "user" is null', "app.Mailer.subject(Mailer.java:5)", "app.Main.main(Main.java:10)"));
    assert.match(hypotheses(fromMethod), /^- \*\*The method returns null on purpose\.\*\* `owner` returns `null` at `src\/main\/java\/app\/Directory\.java:8`/);
  });

  it("follows a caller's argument that is a field, and a this.field receiver", async () => {
    const root = project("java-field-arg", {
      [`${P}/Printer.java`]: ["package app;", "", "public class Printer {", "    public int width(String text) {", "        return text.length();", "    }", "}"],
      [`${P}/Page.java`]: [
        "package app;",
        "",
        "public class Page {",
        "    private final Printer printer = new Printer();",
        "    private String title;",
        "    public Page(String title) {",
        "        title = title;",
        "    }",
        "    public int layout() {",
        "        return this.printer.width(title);",
        "    }",
        "}",
      ],
    });
    const md = await report(root, npe('Cannot invoke "String.length()" because "text" is null', "app.Printer.width(Printer.java:5)", "app.Page.layout(Page.java:10)"));
    assert.match(md, /`text` is a parameter of `width`, passed as `title` at `src\/main\/java\/app\/Page\.java:10`/);
    assert.match(hypotheses(md), /^- \*\*The field is assigned to itself\.\*\* `src\/main\/java\/app\/Page\.java:7` reads `title = title;`/);
  });

  it("names a private field nothing assigns, but not an injected or non-private one", async () => {
    const service = (field: string) => [
      "package app;",
      "",
      "public class Service {",
      field,
      "    public int run() {",
      "        return repo.count();",
      "    }",
      "}",
    ];
    const crash = (root: string) => report(root, npe('Cannot invoke "app.Repo.count()" because "this.repo" is null', "app.Service.run(Service.java:6)"));
    const plain = project("java-field-plain", { [`${P}/Service.java`]: service("    private Repo repo;") });
    assert.match(hypotheses(await crash(plain)), /^- \*\*The field is never assigned\.\*\* `repo` is declared at `src\/main\/java\/app\/Service\.java:4` with no initializer/);
    for (const [name, field] of [["inject", "    @Autowired\n    private Repo repo;"], ["package", "    Repo repo;"], ["setter", "    private Repo repo;\n    void setRepo(Repo r) { this.repo = r; }"]]) {
      const root = project(`java-field-${name}`, { [`${P}/Service.java`]: service(field as string) });
      assert.doesNotMatch(hypotheses(await crash(root)), /never assigned/, name);
    }
  });

  it("checks a properties key only against a file the class loads, and stays quiet when the key exists", async () => {
    const settings = (file: string) => [
      "package app;",
      "",
      "import java.util.Properties;",
      "",
      "public class Settings {",
      "    private final Properties props = new Properties();",
      `    Settings() throws Exception { props.load(Settings.class.getResourceAsStream("${file}")); }`,
      "    public String get(String key) {",
      "        return props.getProperty(key);",
      "    }",
      "}",
    ];
    const reader = ["package app;", "", "public class Reader {", "    static int port(Settings s) {", '        return Integer.parseInt(s.get("server.port").trim());', "    }", "}"];
    const crash = (root: string) =>
      report(root, npe('Cannot invoke "String.trim()" because the return value of "app.Settings.get(String)" is null', "app.Reader.port(Reader.java:5)"));
    const typo = project("java-props-typo", {
      [`${P}/Settings.java`]: settings("/app.properties"),
      [`${P}/Reader.java`]: reader,
      "src/main/resources/app.properties": ["server-port=8080"],
    });
    const typoReport = await crash(typo);
    assert.match(hypotheses(typoReport), /^- \*\*Property key not in the file\.\*\*.*reads `server\.port`.*it has `server-port`/);
    assert.doesNotMatch(typoReport, /8080/, "property values stay out of the report");
    const present = project("java-props-ok", {
      [`${P}/Settings.java`]: settings("/app.properties"),
      [`${P}/Reader.java`]: reader,
      "src/main/resources/app.properties": ["server.port=8080"],
    });
    assert.equal(hypotheses(await crash(present)), "");
    const unnamed = project("java-props-unnamed", {
      [`${P}/Settings.java`]: settings("").map((l) => l.replace('getResourceAsStream("")', "System.in")),
      [`${P}/Reader.java`]: reader,
      "src/main/resources/other.properties": ["server-port=8080"],
    });
    assert.equal(hypotheses(await crash(unnamed)), "");
  });

  it("flags an int key in a Map<Long, ...>, not a long one", async () => {
    const store = (param: string) => [
      "package app;",
      "",
      "import java.util.HashMap;",
      "import java.util.Map;",
      "",
      "public class Store {",
      "    private final Map<Long, String> names = new HashMap<>();",
      `    public String name(${param} id) {`,
      "        return names.get(id);",
      "    }",
      "    public int width(int id) {",
      "        return name(id).length();",
      "    }",
      "}",
    ];
    const crash = (root: string) =>
      report(root, npe('Cannot invoke "String.length()" because the return value of "app.Store.name(int)" is null', "app.Store.width(Store.java:12)"));
    assert.match(hypotheses(await crash(project("java-box-int", { [`${P}/Store.java`]: store("int") }))), /^- \*\*Map key type differs\.\*\* `names` is a `Map<Long, String>`, but `id`.*is an `int`, boxed to `Integer`/);
    const ok = hypotheses(await crash(project("java-box-long", { [`${P}/Store.java`]: store("long") })));
    assert.doesNotMatch(ok, /Map key type differs/);
    assert.match(ok, /The lookup found nothing/);
  });

  it("does not trace other Java exceptions or old-style NPEs without a message", async () => {
    const root = project("java-other", { [`${P}/A.java`]: ["package app;", "", "public class A {", "    static void f(String s) {", "        s.length();", "    }", "}"] });
    for (const text of [
      'Exception in thread "main" java.lang.IllegalStateException: Cannot invoke "x" because "s" is null\n\tat app.A.f(A.java:5)',
      'Exception in thread "main" java.lang.NullPointerException\n\tat app.A.f(A.java:5)',
    ])
      assert.doesNotMatch(await report(root, text), /Where the bad value came from/);
  });

  it("stays fast on a crafted file of long, header-like lines", async () => {
    const junk = Array.from({ length: 400 }, () => `${"a ".repeat(999)}`);
    const root = project("java-redos", {
      [`${P}/Slow.java`]: ["package app;", "", "public class Slow {", ...junk, "    static void f(String s) {", ...junk.map((l) => `        ${l.slice(0, 1990)}`), "        s.length();", "    }", "}"],
    });
    const started = Date.now();
    await report(root, npe('Cannot invoke "String.length()" because "<local0>" is null', `app.Slow.f(Slow.java:${805})`));
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
  });
});

describe("native hypotheses", () => {
  const base = { relevantRegisters: [], decompiled: [] } as unknown as TriageReport;

  it("recognizes a fill pattern and a use after free in the caller", () => {
    const out = nativeHypotheses({
      ...base,
      relevantRegisters: [{ name: "rdx", value: 0x4141414141414141n }],
      decompiled: [
        {
          name: "sub_11f8",
          role: "caller",
          pseudocode: ["p = malloc(0x20);", "free(p);", "q = malloc(0x20);", "memset(q,0x41,0x20);", "FUN_001011d4(p,7);"].join("\n"),
        },
      ],
    } as unknown as TriageReport);
    assert.equal(out.length, 2);
    assert.match(out[0] ?? "", /`rdx` = `0x4141414141414141` is the byte `0x41` \('A'\) repeated/);
    assert.match(out[1] ?? "", /caller `sub_11f8` calls `free\(p\);` and later uses `p` again: `FUN_001011d4\(p,7\);`.*`memset\(q,0x41,0x20\);`/);
  });

  it("ignores NULL, all-ones, ordinary pointers and a pointer reassigned after free", () => {
    const out = nativeHypotheses({
      ...base,
      relevantRegisters: [
        { name: "rax", value: 0n },
        { name: "rbx", value: 0xffffffffffffffffn },
        { name: "rcx", value: 0x55d0c0ffee10n },
      ],
      decompiled: [{ name: "f", role: "crash", pseudocode: "free(p);\np = malloc(8);\nuse(p);" }],
    } as unknown as TriageReport);
    assert.deepEqual(out, []);
  });
});
