import { failure, frame, type FailureLanguage, type ParsedFailure } from "../failure.js";

interface SentryFrame {
  readonly filename?: string;
  readonly abs_path?: string;
  readonly function?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly in_app?: boolean;
  readonly context_line?: string;
  readonly vars?: Record<string, unknown>;
}

const PLATFORM: Readonly<Record<string, FailureLanguage>> = { python: "python", node: "node", javascript: "node" };

/**
 * A Sentry event as JSON (an exported event, or the API's event payload):
 * the last exception in `exception.values`, its frames most recent first, and
 * each frame's `vars` as its locals.
 */
export function parseSentry(text: string): ParsedFailure | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"exception"')) return null;
  let event: { platform?: string; exception?: { values?: { type?: string; value?: string; stacktrace?: { frames?: SentryFrame[] } }[] } };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const language = PLATFORM[event.platform ?? ""];
  const exception = event.exception?.values?.at(-1);
  if (language === undefined || exception === undefined) return null;
  const frames = (exception.stacktrace?.frames ?? [])
    .map((f) =>
      frame({
        function: f.function ?? "<anonymous>",
        file: f.abs_path ?? f.filename ?? null,
        line: f.lineno ?? null,
        column: f.colno ?? null,
        own: f.in_app !== false,
        code: f.context_line?.trim() ?? null,
        ...(f.vars === undefined
          ? {}
          : { locals: Object.fromEntries(Object.entries(f.vars).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) }),
      }),
    )
    .reverse();
  return failure({
    language,
    header: "exception",
    errorType: exception.type ?? "Error",
    message: exception.value ?? "",
    frames,
    start: 0,
  });
}
