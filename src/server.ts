import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { toCoreIssue } from "./coreIssue.js";
import { parseFailure } from "./failure.js";
import { logContext, toFailureIssue } from "./failureIssue.js";
import { detectFile, MAX_TEXT_BYTES, type FileKind } from "./fileKind.js";
import { renderIssueMarkdown, withLog, type Issue } from "./issue.js";
import type { ReaCommand } from "./rea.js";
import { suggestFix, withSuggestion } from "./ai.js";
import { attachSource } from "./source.js";
import { triage } from "./triage.js";
import { APP_CSS, APP_JS, INDEX_HTML } from "./web/page.js";

export interface ServeOptions {
  readonly port: number;
  readonly rea: ReaCommand;
  readonly gdb: string | null;
  readonly sourceRoot: string | null;
  /** Enables "Ask AI"; each request still needs the user's click and confirmation. */
  readonly ai?: boolean;
  /** Largest accepted upload; core dumps can be big. */
  readonly maxUploadBytes?: number;
}

export interface RunningServer {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

interface Upload {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly kind: FileKind["kind"];
}

interface Analyzed {
  readonly id: string;
  readonly name: string;
  readonly at: string;
  issue: Issue;
  markdown: string;
}

const MAX_JSON_BYTES = MAX_TEXT_BYTES * 2;
const DEFAULT_MAX_UPLOAD = 4 * 1024 * 1024 * 1024;

/**
 * Local web UI. Listens on 127.0.0.1 only. Every API call must carry the
 * random session token, and the Host header must name this server, which
 * blocks other local programs and DNS-rebinding web pages. Uploads live in a
 * private temporary directory that is deleted on close.
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
  const token = randomBytes(24).toString("hex");
  const uploadDir = await mkdtemp(join(tmpdir(), "crashlens-"));
  const uploads = new Map<string, Upload>();
  const analyzed: Analyzed[] = [];
  let sourceRoot = options.sourceRoot;
  const maxUpload = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD;
  let port = options.port;

  const finish = async (name: string, issue: Issue): Promise<Analyzed> => {
    const enriched = sourceRoot === null ? issue : await attachSource(issue, sourceRoot);
    const entry: Analyzed = {
      id: randomUUID(),
      name,
      at: new Date().toISOString(),
      issue: enriched,
      markdown: renderIssueMarkdown(enriched),
    };
    analyzed.push(entry);
    return entry;
  };

  const analyzeText = async (name: string, text: string) => {
    const parsed = parseFailure(text);
    if (!parsed.ok) throw new HttpError(422, parsed.error.message);
    return finish(name, toFailureIssue(parsed.value, name, text));
  };

  const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
    "GET /api/state": async () => ({
      sourceRoot,
      aiEnabled: options.ai === true,
      issues: analyzed,
      uploads: [...uploads.values()].map(({ path: _path, ...rest }) => rest),
    }),
    "POST /api/text": async (req) => {
      const body = await readJson(req);
      const text = typeof body["text"] === "string" ? body["text"] : "";
      const name = typeof body["name"] === "string" && body["name"] !== "" ? body["name"] : "pasted text";
      return analyzeText(name, text);
    },
    "PUT /api/upload": async (req, url) => {
      const name = (url.searchParams.get("name") ?? "upload").slice(0, 200);
      const id = randomUUID();
      // Keep the original file name: core dumps record the binary by name,
      // and matching the binary to the core relies on it.
      const dir = join(uploadDir, id);
      await mkdir(dir, { mode: 0o700 });
      const path = join(dir, safeName(name));
      const declared = Number(req.headers["content-length"] ?? "0");
      if (declared > maxUpload) throw new HttpError(413, "File is too large.");
      let received = 0;
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxUpload) req.destroy(new HttpError(413, "File is too large."));
      });
      await pipeline(req, createWriteStream(path, { mode: 0o600 }));
      const kind = (await detectFile(path)).kind;
      const upload: Upload = { id, name, path, size: (await stat(path)).size, kind };
      uploads.set(id, upload);
      // Text logs are analyzed right away; cores wait for their binary.
      if (kind === "text") {
        const result = await analyzeText(name, await readFile(path, "utf8"));
        uploads.delete(id);
        await rm(dir, { recursive: true, force: true });
        return { upload: { id, name, size: upload.size, kind }, analyzed: result };
      }
      return { upload: { id, name, size: upload.size, kind } };
    },
    "POST /api/core": async (req) => {
      const body = await readJson(req);
      const core = uploads.get(String(body["core"]));
      const binary = uploads.get(String(body["binary"]));
      if (core?.kind !== "core") throw new HttpError(400, "Upload a core dump first.");
      if (binary?.kind !== "binary") throw new HttpError(400, "Upload the binary that crashed.");
      const result = await triage({ corePath: core.path, binaryPath: binary.path, rea: options.rea, gdb: options.gdb });
      if (!result.ok) throw new HttpError(422, result.error.message);
      let issue = toCoreIssue(result.value);
      // Show the names the user uploaded, not the private temp paths.
      issue = {
        ...issue,
        evidence: issue.evidence.map((line) =>
          line.replaceAll(core.path, core.name).replaceAll(binary.path, binary.name),
        ),
        facts: issue.facts.map((fact) => ({ ...fact, value: fact.value.replaceAll(binary.path, binary.name) })),
      };
      const log = typeof body["log"] === "string" ? body["log"] : "";
      if (log !== "") issue = withLog(issue, logContext(log, log.length));
      return finish(core.name, issue);
    },
    "POST /api/source": async (req) => {
      const body = await readJson(req);
      const path = typeof body["path"] === "string" ? body["path"].trim() : "";
      if (path === "") {
        sourceRoot = null;
        return { sourceRoot };
      }
      if (!isAbsolute(path)) throw new HttpError(400, "Use an absolute folder path.");
      const info = await stat(path).catch(() => null);
      if (info === null || !info.isDirectory()) throw new HttpError(400, "That folder doesn't exist.");
      sourceRoot = path;
      return { sourceRoot };
    },
    "POST /api/ai": async (req) => {
      if (options.ai !== true) throw new HttpError(403, "AI suggestions are off. Start crashlens with --ai to enable them.");
      const body = await readJson(req);
      const entry = analyzed.find((a) => a.id === body["id"]);
      if (entry === undefined) throw new HttpError(404, "Unknown report.");
      const result = await suggestFix(entry.issue);
      if (!result.ok) throw new HttpError(502, result.error.message);
      entry.issue = withSuggestion(entry.issue, result.value);
      entry.markdown = renderIssueMarkdown(entry.issue);
      return entry;
    },
    "POST /api/clear": async () => {
      analyzed.length = 0;
      for (const upload of uploads.values()) await rm(dirname(upload.path), { recursive: true, force: true });
      uploads.clear();
      return {};
    },
  };

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
        throw new HttpError(403, "Unexpected Host header.");
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, INDEX_HTML, "text/html");
      if (req.method === "GET" && url.pathname === "/app.js") return send(res, 200, APP_JS, "text/javascript");
      if (req.method === "GET" && url.pathname === "/app.css") return send(res, 200, APP_CSS, "text/css");
      if (req.method === "GET" && url.pathname === "/favicon.ico") return void res.writeHead(204).end();

      const route = routes[`${req.method} ${url.pathname}`];
      if (route === undefined) throw new HttpError(404, "Not found.");
      if (!tokenMatches(req.headers["x-crashlens-token"], token)) throw new HttpError(401, "Missing or wrong session token.");
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, "Cross-origin request.");
      sendJson(res, 200, await route(req, url));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A plain file name: no directories, no leading dots, no control characters. */
function safeName(name: string): string {
  const cleaned = basename(name.replaceAll("\\", "/")).replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "");
  return cleaned === "" ? "upload" : cleaned.slice(0, 200);
}

function tokenMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string" || header.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(token));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Expected a JSON object.");
}

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, ...SECURITY_HEADERS });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(
    res,
    status,
    JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? `0x${item.toString(16)}` : item)),
    "application/json",
  );
}
