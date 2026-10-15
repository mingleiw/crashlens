import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { serve, type RunningServer } from "../src/server.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "failures");

let server: RunningServer;
let port: number;

before(async () => {
  server = await serve({ port: 0, rea: { file: "rea", args: [] }, gdb: null, sourceRoot: null });
  port = Number(new URL(server.url).port);
});
after(() => server.close());

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** Raw HTTP so tests control the Host and Origin headers exactly. */
function call(
  method: string,
  path: string,
  options: { body?: string | Buffer; headers?: Record<string, string>; token?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(options.token === false ? {} : { "X-Crashlens-Token": server.token }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("crashlens serve: access control", () => {
  it("serves the page with a strict CSP but no data without the token", async () => {
    const page = await call("GET", "/", { token: false });
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'; script-src 'self'/);
    assert.equal((await call("GET", "/api/state", { token: false })).status, 401);
    assert.equal((await call("GET", "/api/state", { headers: { "X-Crashlens-Token": "0".repeat(48) } })).status, 401);
  });

  it("rejects foreign Host headers (DNS rebinding) and cross-origin requests", async () => {
    assert.equal((await call("GET", "/api/state", { headers: { Host: `evil.example:${port}` } })).status, 403);
    assert.equal((await call("GET", "/", { headers: { Host: "evil.example" } })).status, 403);
    assert.equal((await call("GET", "/api/state", { headers: { Origin: "http://evil.example" } })).status, 403);
    assert.equal((await call("GET", "/api/state", { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  });

  it("puts the token in the URL fragment so it is never sent in requests", () => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{48}$/);
  });
});

describe("crashlens serve: analysis", () => {
  it("analyzes pasted text and keeps it in the session", async () => {
    const text = readFileSync(join(fixtures, "py-none.txt"), "utf8");
    const reply = await call("POST", "/api/text", { body: JSON.stringify({ text }), headers: { "Content-Type": "application/json" } });
    assert.equal(reply.status, 200);
    const entry = JSON.parse(reply.body) as { issue: { kind: string; where: string }; markdown: string };
    assert.equal(entry.issue.kind, "python-none");
    assert.equal(entry.issue.where, "total");
    assert.match(entry.markdown, /^# Exception: Value was None in `total`/);
    const state = JSON.parse((await call("GET", "/api/state")).body) as { issues: unknown[] };
    assert.equal(state.issues.length, 1);
  });

  it("analyzes an uploaded log immediately and explains unreadable text", async () => {
    const log = readFileSync(join(fixtures, "asan-uaf.txt"));
    const ok = JSON.parse((await call("PUT", "/api/upload?name=crash.log", { body: log })).body) as {
      analyzed: { issue: { kind: string } };
    };
    assert.equal(ok.analyzed.issue.kind, "asan-use-after-free");
    const bad = await call("PUT", "/api/upload?name=notes.txt", { body: "nothing crashed\n" });
    assert.equal(bad.status, 422);
    assert.match(JSON.parse(bad.body).error, /No supported failure found/);
  });

  it("keeps uploads inside its private folder whatever the file name says", async () => {
    const upload = (name: string) => call("PUT", `/api/upload?name=${encodeURIComponent(name)}`, { body: Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...Array(60).fill(0)]) });
    for (const name of ["../../escape", "/etc/passwd", "..", "a\\..\\b"]) assert.equal((await upload(name)).status, 200);
    const leaked = (await readdir(tmpdir())).filter((n) => n === "escape" || n === "b");
    assert.deepEqual(leaked, []);
  });

  it("requires a real core and binary before running core analysis", async () => {
    const reply = await call("POST", "/api/core", { body: JSON.stringify({ core: "nope", binary: "nope" }) });
    assert.equal(reply.status, 400);
    assert.match(JSON.parse(reply.body).error, /core dump first/);
  });

  it("only accepts an existing absolute source folder", async () => {
    const set = (path: string) => call("POST", "/api/source", { body: JSON.stringify({ path }) });
    assert.equal((await set("relative/dir")).status, 400);
    assert.equal((await set("/no/such/folder")).status, 400);
    assert.equal((await set(tmpdir())).status, 200);
    assert.equal(JSON.parse((await set("")).body).sourceRoot, null);
  });

  it("refuses AI suggestions unless started with --ai", async () => {
    const reply = await call("POST", "/api/ai", { body: JSON.stringify({ id: "x" }) });
    assert.equal(reply.status, 403);
    assert.match(JSON.parse(reply.body).error, /Start crashlens with --ai/);
    assert.equal(JSON.parse((await call("GET", "/api/state")).body).aiEnabled, false);
  });

  it("clears the session", async () => {
    await call("POST", "/api/clear");
    const state = JSON.parse((await call("GET", "/api/state")).body) as { issues: unknown[]; uploads: unknown[] };
    assert.deepEqual([state.issues.length, state.uploads.length], [0, 0]);
  });
});
