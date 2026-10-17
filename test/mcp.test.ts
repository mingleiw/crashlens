import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { serveMcp } from "../src/mcp.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const pyNone = join(fixtures, "failures", "py-none.txt");

type Reply = { id: number | null; result?: any; error?: { code: number; message: string } };

/** Send JSON-RPC lines to a fresh server and collect every reply. */
async function session(messages: readonly unknown[], cwd = fixtures): Promise<Reply[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => (written += chunk));
  const done = serveMcp(input, output, { rea: { file: "/nonexistent/rea", args: [] }, gdb: null, cwd });
  for (const message of messages) input.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  input.end();
  await done;
  return written
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const text = (reply: Reply | undefined): string => reply?.result?.content?.[0]?.text ?? "";

describe("MCP server", () => {
  const work = mkdtempSync(join(tmpdir(), "crashlens-mcp-"));
  after(() => rmSync(work, { recursive: true, force: true }));

  it("negotiates the protocol, lists read-only tools and ignores notifications", async () => {
    const replies = await session([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ]);
    assert.equal(replies.length, 4);
    const byId = new Map(replies.map((reply) => [reply.id, reply]));
    assert.equal(byId.get(1)?.result.protocolVersion, "2025-06-18");
    assert.equal(byId.get(1)?.result.serverInfo.name, "crashlens");
    assert.match(byId.get(1)?.result.instructions, /never runs the program/);
    assert.equal(byId.get(3)?.result.protocolVersion, "2025-11-25");
    const tools = byId.get(2)?.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["analyze_failure", "analyze_core_dump", "decompile_function", "analyze_crash_folder"],
    );
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
    assert.deepEqual(byId.get(4)?.result, {});
  });

  it("analyzes failure text and log files", async () => {
    const replies = await session([
      call(1, "analyze_failure", { text: readFileSync(pyNone, "utf8") }),
      call(2, "analyze_failure", { path: pyNone }),
      call(3, "analyze_failure", { path: "failures/py-none.txt" }),
    ]);
    const [fromText, fromPath, relative] = replies.sort((a, b) => Number(a.id) - Number(b.id));
    assert.match(text(fromText), /^# Exception: Value was None in `total`/);
    assert.match(text(fromText), /agent input/);
    assert.equal(fromText?.result.isError, undefined);
    assert.equal(text(fromPath).split("\n")[0], text(fromText).split("\n")[0]);
    assert.match(text(relative), /^# Exception: Value was None in `total`/, "relative paths resolve against cwd");
  });

  it("groups a folder of failures into bugs", async () => {
    const [reply] = await session([call(1, "analyze_crash_folder", { dir: join(fixtures, "panics") })]);
    assert.match(text(reply), /^# crashlens: \d+ failures, \d+ distinct bugs/);
  });

  it("returns readable tool errors for bad input and failed analyses", async () => {
    const replies = await session([
      call(1, "analyze_failure", {}),
      call(2, "analyze_failure", { text: "x", path: pyNone }),
      call(3, "analyze_failure", { text: "all good, nothing failed" }),
      call(4, "analyze_core_dump", { core_path: join(work, "core") }),
      call(5, "analyze_core_dump", { core_path: join(work, "core"), binary_path: join(work, "app") }),
      call(6, "analyze_failure", { path: join(work, "missing.log") }),
      call(7, "decompile_function", { binary_path: join(work, "app") }),
      call(8, "decompile_function", { binary_path: join(work, "missing-app"), function: "sub_11f8" }),
    ]);
    // Calls run concurrently, so replies arrive in completion order.
    replies.sort((a, b) => Number(a.id) - Number(b.id));
    for (const reply of replies) {
      assert.equal(reply.result?.isError, true, `call ${reply.id} should be a tool error`);
      assert.match(text(reply), /^crashlens: \S/);
    }
    assert.match(text(replies[0]), /exactly one of text or path/);
    assert.match(text(replies[3]), /binary_path is required/);
  });

  it("rejects unknown methods, unknown tools and malformed JSON", async () => {
    const replies = await session([
      "{not json",
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_program", arguments: {} } },
    ]);
    replies.sort((a, b) => Number(a.id) - Number(b.id));
    assert.deepEqual(
      replies.map((reply) => [reply.id, reply.error?.code]),
      [
        [null, -32700],
        [1, -32601],
        [2, -32602],
      ],
    );
  });
});
