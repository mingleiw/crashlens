import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { analyzeCore, analyzeFile, analyzeText, type Analysis } from "./analyze.js";
import { renderBatchMarkdown, triageBatch } from "./batch.js";
import { renderIssueMarkdown, type Issue } from "./issue.js";
import type { ReaCommand } from "./rea.js";
import { attachSource } from "./source.js";

/**
 * A Model Context Protocol server on stdio (newline-delimited JSON-RPC), so
 * coding agents can triage failures without shelling out and parsing text.
 * Read-only like the CLI: it reads the files it is given and never runs them.
 */

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_TEXT = 4 * 1024 * 1024;

const INSTRUCTIONS = `crashlens explains why a program failed, from what the failure left behind: a Go/Rust panic, a Python/Java/Node exception, an ASan/LSan/UBSan report, or a Linux core dump plus its binary. It never runs the program.
Call it when a test, script or service has crashed or thrown and you have the output, a log file or a core dump. The report names the failing frame in the user's own code, the crash type with a confidence level, what to check next, and a signature that stays the same for the same bug. Pass source_dir (the repository root) to get the failing lines and git blame.`;

const SOURCE_DIR = {
  type: "string",
  description: "Absolute path of the repository root. Adds the failing source lines and the last commit that touched them.",
};

const TOOLS = [
  {
    name: "analyze_failure",
    title: "Explain a panic, exception or sanitizer report",
    description:
      "Turn failure output into a bug report: where it failed (first frame in the user's code), why, the log lines just before it, and next steps. Accepts Go/Rust panics, Python tracebacks (root cause of chained exceptions), Java and Node.js stack traces, and ASan/LSan/UBSan reports. Pass the output as `text` (for example a failing test run) or a saved log as `path`. Log noise around the failure is fine.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The failure output, including the log lines before it if you have them." },
        path: { type: "string", description: "Absolute path of a log file containing the failure. Use instead of text." },
        source_dir: SOURCE_DIR,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "analyze_core_dump",
    title: "Explain a native crash from a core dump",
    description:
      "Explain a Linux x86-64 core dump: signal, crash type (NULL dereference, stack overflow, abort, ...), the faulting function+offset in the binary, backtrace, faulting instruction and the register that held the bad pointer. Needs the exact binary that crashed. Uses REA (and gdb if installed) on the files only; the program is never executed.",
    inputSchema: {
      type: "object",
      properties: {
        core_path: { type: "string", description: "Absolute path of the core dump." },
        binary_path: { type: "string", description: "Absolute path of the binary that crashed (the same build)." },
        log_path: { type: "string", description: "Absolute path of the program's log; its last lines are added to the report." },
        source_dir: SOURCE_DIR,
      },
      required: ["core_path", "binary_path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "analyze_crash_folder",
    title: "Group a folder of crashes into distinct bugs",
    description:
      "Find every core dump and failure log under a folder (by content), analyze each, and group them by signature into distinct bugs ranked by count, in one call. Use this instead of grepping a CI artifacts folder, a crash directory or a pile of logs: it handles hundreds of large, noisy files in about a second and skips passing logs.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Absolute path of the folder." },
        binary_path: { type: "string", description: "Absolute path of the binary, needed only if the folder has core dumps." },
        source_dir: SOURCE_DIR,
      },
      required: ["dir"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

export interface McpOptions {
  readonly rea: ReaCommand;
  readonly gdb: string | null;
  /** Relative paths resolve against this; defaults to the process's working directory. */
  readonly cwd?: string;
  readonly version?: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type JsonRpcId = string | number;

class ToolError extends Error {}

/** Serve MCP over a pair of streams until the input ends. */
export async function serveMcp(input: Readable, output: Writable, options: McpOptions): Promise<void> {
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const pending: Promise<void>[] = [];
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === "") continue;
    let message: { id?: JsonRpcId; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const id = message.id;
    if (typeof message.method !== "string") {
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } });
      continue;
    }
    // Notifications (initialized, cancelled, ...) need no reply.
    if (id === undefined) continue;
    const method = message.method;
    const params = (message.params ?? {}) as Record<string, unknown>;
    pending.push(
      handle(method, params, options).then(
        (result) => void send({ jsonrpc: "2.0", id, result }),
        (error: unknown) =>
          void send({
            jsonrpc: "2.0",
            id,
            error:
              error instanceof MethodError
                ? { code: error.code, message: error.message }
                : { code: -32603, message: error instanceof Error ? error.message : String(error) },
          }),
      ),
    );
  }
  await Promise.all(pending);
}

class MethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function handle(method: string, params: Record<string, unknown>, options: McpOptions): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const requested = params["protocolVersion"];
      return {
        protocolVersion:
          typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "crashlens", version: options.version ?? "0.1.0" },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = params["name"];
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      if (typeof name !== "string" || !TOOLS.some((tool) => tool.name === name))
        throw new MethodError(-32602, `Unknown tool: ${String(name)}`);
      try {
        return { content: [{ type: "text", text: await callTool(name, args, options) }] } satisfies ToolResult;
      } catch (error) {
        // Bad input and failed analyses are tool errors the agent can read and act on.
        const text = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `crashlens: ${text}` }], isError: true } satisfies ToolResult;
      }
    }
    default:
      throw new MethodError(-32601, `Method not found: ${method}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>, options: McpOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const path = (key: string, required: boolean): string | undefined => {
    const value = args[key];
    if (value === undefined || value === null || value === "") {
      if (required) throw new ToolError(`${key} is required.`);
      return undefined;
    }
    if (typeof value !== "string") throw new ToolError(`${key} must be a string.`);
    return isAbsolute(value) ? value : resolve(cwd, value);
  };
  const source = path("source_dir", false);
  const enrich = async (issue: Issue) => (source === undefined ? issue : attachSource(issue, source));
  const report = async (analysis: Analysis) => {
    if (!analysis.ok) throw new ToolError(analysis.message);
    return renderIssueMarkdown(await enrich(analysis.issue));
  };

  switch (name) {
    case "analyze_failure": {
      const text = args["text"];
      const file = path("path", false);
      if ((typeof text === "string" && text !== "") === (file !== undefined))
        throw new ToolError("Pass exactly one of text or path.");
      if (file !== undefined) return report(analyzeFile(file));
      if (typeof text !== "string") throw new ToolError("text must be a string.");
      if (text.length > MAX_TEXT) throw new ToolError("text is larger than 4 MiB; save it to a file and pass path.");
      return report(analyzeText(text, "agent input"));
    }
    case "analyze_core_dump":
      return report(
        await analyzeCore({
          corePath: path("core_path", true) as string,
          binaryPath: path("binary_path", true) as string,
          logPath: path("log_path", false),
          rea: options.rea,
          gdb: options.gdb,
        }),
      );
    case "analyze_crash_folder": {
      const result = await triageBatch({
        directory: path("dir", true) as string,
        binaryPath: path("binary_path", false) ?? null,
        rea: options.rea,
        gdb: options.gdb,
        enrich,
      });
      return renderBatchMarkdown(result);
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}
