import { readFile } from "node:fs/promises";
import { basename, extname, relative } from "node:path";

/**
 * Static walk from the failing line back to where the bad value was produced,
 * across the stack's own frames, plus a few checks that turn the producer into
 * a concrete hypothesis (a missing `await`, a lookup that found nothing, a key
 * nobody writes, a value read from the environment). Reads source only; every
 * result is a guess from the text and is labelled as one.
 */

/** A stack frame resolved to a real file under the source root, crash first. */
export interface TraceFrame {
  readonly file: string;
  readonly line: number;
  readonly function: string;
}

export interface TraceCode {
  readonly heading: string;
  readonly language: string;
  readonly lines: readonly string[];
}

export interface TraceResult {
  readonly hypotheses: readonly string[];
  readonly steps: readonly string[];
  readonly code: readonly TraceCode[];
}

type Lang = "python" | "js";

const LANG: Readonly<Record<string, Lang>> = {
  ".py": "python", ".js": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".tsx": "js", ".jsx": "js",
};
const MAX_BODY_LINES = 25;
const MAX_SCANNED_FILES = 3_000;
const MAX_FILE_BYTES = 1024 * 1024;
const IDENT = "[A-Za-z_$][\\w$]*";

const NIL_KINDS = new Set(["node-undefined-access", "node-undefined-write", "python-none"]);
const OPERAND = /unsupported operand type|can only concatenate|must be str|must be real number|not supported between instances/;

interface Producer {
  readonly file: string;
  /** 0-based line index. */
  readonly index: number;
  /** The expression that produced the value (assignment right-hand side or call argument). */
  readonly expr: string;
}

interface Definition {
  readonly name: string;
  readonly file: string;
  readonly start: number;
  readonly lines: readonly string[];
  readonly async: boolean;
}

export async function traceValue(
  kind: string,
  message: string,
  frames: readonly TraceFrame[],
  root: string,
  allFiles: () => Promise<readonly string[]>,
): Promise<TraceResult | null> {
  const crash = frames[0];
  if (crash === undefined) return null;
  const lang = LANG[extname(crash.file)];
  if (lang === undefined) return null;
  const files = new Files(root);
  const crashLine = (await files.lines(crash.file))?.[crash.line - 1];
  if (crashLine === undefined) return null;

  const hypotheses: string[] = [];
  const steps: string[] = [];
  const code: TraceCode[] = [];
  const at = (file: string, index: number) => `\`${relative(root, file)}:${index + 1}\``;

  const addDefinition = (def: Definition, role: string) => {
    if (code.some((c) => c.heading.includes(`(${def.name})`))) return;
    code.push({
      heading: `Code: ${relative(root, def.file)}:${def.start + 1} (${def.name}), ${role}`,
      language: lang === "python" ? "python" : "javascript",
      lines: numbered(def.lines, def.start),
    });
  };

  // Operand type errors: the bad operand is often a module setting read from the environment.
  if (lang === "python" && OPERAND.test(message)) {
    for (const match of crashLine.matchAll(new RegExp(`\\b(${IDENT})\\.(${IDENT})\\b`, "g"))) {
      const [, mod, name] = match as unknown as [string, string, string];
      const file = (await allFiles()).find((f) => basename(f) === `${mod}.py`);
      const lines = file === undefined ? null : await files.lines(file);
      if (file === undefined || lines === null) continue;
      const index = lines.findIndex((l) => new RegExp(`^${name}\\s*(?::[^=]+)?=(?!=)`).test(l));
      if (index === -1) continue;
      steps.push(`\`${mod}.${name}\` is set at ${at(file, index)}: \`${lines[index]?.trim()}\``);
      const env = environment(lines[index] ?? "");
      if (env !== null)
        hypotheses.push(
          `**Environment value used as a number.** \`${mod}.${name}\` comes from ${env} at ${at(file, index)}, which is always a string. Convert it where it is read (\`int(...)\` or \`float(...)\`), not at each use.`,
        );
    }
    return hypotheses.length + steps.length === 0 ? null : { hypotheses, steps, code };
  }

  const target = targetOf(kind, message, crashLine);
  if (target === null) return null;
  steps.push(`The bad value is \`${target.expr}\` at ${at(crash.file, crash.line - 1)}.`);

  // Follow a variable back through assignments and call arguments, from frame `from` outward.
  const follow = async (start: string, from: number) => {
    let name = start;
    const names = new Set([name]);
    for (let f = from; f < frames.length; f++) {
      const frame = frames[f] as TraceFrame;
      const lines = await files.lines(frame.file);
      if (lines === null) break;
      // A comprehension's `for x in xs` is on the frame's own line.
      let index = /^<\w*(?:expr|comp)>$/.test(frame.function) ? frame.line : frame.line - 1;
      const fn = functionStart(lines, frame.line - 1, frame.function, lang);
      let assigned = assignment(lines, fn === null ? 0 : fn.index + 1, index, name, lang);
      // `a = b`: keep following `b` in the same function.
      while (assigned !== null) {
        steps.push(`\`${name}\` is assigned at ${at(frame.file, assigned.index)}: \`${lines[assigned.index]?.trim()}\``);
        const alias = new RegExp(`^(${IDENT})$`).exec(assigned.rhs);
        if (alias === null || names.has(alias[1] as string))
          return { name, names, frame: f, producer: { file: frame.file, index: assigned.index, expr: assigned.rhs } };
        name = alias[1] as string;
        names.add(name);
        index = assigned.index;
        assigned = assignment(lines, fn === null ? 0 : fn.index + 1, index, name, lang);
      }
      // A comprehension runs inside the next frame's function: same names.
      if (/^<\w*(?:expr|comp)>$/.test(frame.function)) continue;
      const position = fn === null ? -1 : fn.params.indexOf(name);
      if (position === -1) break;
      const caller = frames[f + 1];
      const callerLine = caller === undefined ? undefined : (await files.lines(caller.file))?.[caller.line - 1];
      if (caller === undefined || callerLine === undefined) {
        steps.push(`\`${name}\` is a parameter of \`${shortName(frame.function)}\`; its caller is not in the stack.`);
        break;
      }
      const arg = callArgs(callerLine, shortName(frame.function))?.[position];
      if (arg === undefined) break;
      steps.push(`\`${name}\` is parameter ${position + 1} of \`${shortName(frame.function)}\`, passed as \`${arg}\` at ${at(caller.file, caller.line - 1)}.`);
      const simple = new RegExp(`^(${IDENT})$`).exec(arg.trim());
      if (simple === null)
        return { name, names, frame: f + 1, producer: { file: caller.file, index: caller.line - 1, expr: arg.trim() } };
      name = simple[1] as string;
      names.add(name);
    }
    return { name, names, frame: -1, producer: null as Producer | null };
  };

  // The value is a call result on the failing line itself (`RATES.get(currency).value`), or a variable to follow.
  const chain = target.expr.endsWith(")")
    ? { name: target.expr, names: new Set<string>(), frame: 0, producer: { file: crash.file, index: crash.line - 1, expr: target.expr } as Producer | null }
    : await follow(target.root, 0);
  const { name, names, producer } = chain;

  // For a lookup, follow the key back too: its value is what failed to match.
  const seeds: Literal[] = [];
  const lookupCall = producer === null ? null : callee(producer.expr);
  const lookupDef =
    lookupCall === null || producer === null ? null : await files.definition(lookupCall.short, lookupCall.module, producer.file, lang, allFiles);
  const isLookup =
    producer !== null && NIL_KINDS.has(kind) && (LOOKUP.test(producer.expr) || (lookupDef !== null && LOOKUP.test(lookupDef.lines.join("\n"))));
  const key = producer === null || !isLookup ? null : lookupKey(producer.expr);
  if (producer !== null && key !== null) {
    const simple = new RegExp(`^${IDENT}$`).test(key);
    const keyChain = simple ? await follow(key, chain.frame) : null;
    const expr = simple ? keyChain?.producer?.expr ?? null : key;
    const from = simple ? keyChain?.producer ?? null : producer;
    const literal = expr === null || from === null ? null : await files.literalOf(expr, from.file, from.index, allFiles);
    if (literal !== null) {
      steps.push(`The lookup key is \`${literal.value}\`${expr === literal.value ? "" : ` (\`${expr}\`)`}, set at ${at(literal.file, literal.index)}.`);
      seeds.push({ value: literal.value.slice(1, -1), file: literal.file, index: literal.index });
    }
  }

  if (producer !== null) {
    const call = callee(producer.expr);
    const def = call === null ? null : await files.definition(call.short, call.module, producer.file, lang, allFiles);
    if (call !== null && def !== null) {
      addDefinition(def, `produces \`${name}\``);
      if (def.async && !call.awaited)
        hypotheses.push(
          lang === "js"
            ? `**Missing \`await\`.** \`${def.name}\` is \`async\`, so \`${producer.expr.trim()}\` at ${at(producer.file, producer.index)} returns a Promise. \`${name}\` is that Promise, not the value, so \`${target.expr}\` is \`undefined\`. Likely fix: \`await\` the call (and make the caller \`async\`).`
            : `**Missing \`await\`.** \`${def.name}\` is \`async def\`, so \`${producer.expr.trim()}\` at ${at(producer.file, producer.index)} returns a coroutine, not the value. Likely fix: \`await\` the call.`,
        );
      else if (NIL_KINDS.has(kind) && LOOKUP.test(def.lines.join("\n")))
        hypotheses.push(
          `**The lookup found nothing.** \`${def.name}\` returns ${lang === "js" ? "`undefined`" : "`None`"} when no entry matches, and \`${producer.expr.trim()}\` at ${at(producer.file, producer.index)} got that. Check the key that was passed against the stored keys before guarding the crash site.`,
        );
      const shifted = zipShift(def);
      if (shifted !== null)
        hypotheses.push(
          `**Columns shifted.** \`${shifted.text}\` at ${at(def.file, shifted.index)} pairs \`${shifted.left}\` with \`${shifted.right}\`, which are sliced differently, so each key gets the next column's value${target.key === null ? "" : ` and the last key (here \`${target.key}\`) can go missing`}. Line the two sides up.`,
        );
    } else if (NIL_KINDS.has(kind) && LOOKUP.test(producer.expr))
      hypotheses.push(
        `**The lookup found nothing.** \`${producer.expr.trim()}\` at ${at(producer.file, producer.index)} returns ${lang === "js" ? "`undefined`" : "`None`"} when no entry matches. Check the key it was given against the stored keys before guarding the crash site.`,
      );
  }

  // A literal on a stack line that differs only in case from one in the same code.
  if (NIL_KINDS.has(kind)) {
    const mismatch = await caseMismatch(frames, seeds, files, root, allFiles);
    if (mismatch !== null) hypotheses.push(mismatch);
  }

  // A field or key that no code writes, with near matches that are written.
  const builder = target.key === null ? null : await builtWithout(target.key, names, frames, files, lang, await allFiles());
  if (builder !== null) {
    const near = builder.keys.filter((k) => similar(k, target.key as string));
    hypotheses.push(
      `**Field name mismatch.** The ${lang === "python" ? "dict" : "object"} built at ${at(builder.file, builder.index)} has ${builder.shared.map((k) => `\`${k}\``).join(", ")}, which this code also reads, but no \`${target.key}\`${near.length > 0 ? `; it has ${near.map((k) => `\`${k}\``).join(", ")} instead` : ""}. The code that builds it and the code that reads it disagree on the name: fix one side rather than defaulting the missing key.`,
    );
  } else if (target.key !== null) {
    const keys = await writtenKeys(await allFiles(), files, lang);
    const exact = keys.filter((k) => k.key === target.key);
    const near = keys.filter((k) => k.key !== target.key && similar(k.key, target.key as string));
    if (exact.length === 0 && near.length > 0) {
      const list = unique(near.map((k) => `\`${k.key}\` (${at(k.file, k.index)})`)).slice(0, 3).join(", ");
      hypotheses.push(
        `**Field name mismatch.** No code under the source root writes \`${target.key}\`, but ${list} ${near.length === 1 ? "is" : "are"} written. The code that builds this ${lang === "python" ? "dict" : "object"} and the code that reads it probably disagree on the name; fix one side rather than defaulting the missing key.`,
      );
    }
  }

  return { hypotheses, steps, code };
}

const LOOKUP = /\.find\(|\.get\(|\.findOne\(|\.first\(|\.filter\(|\.search\(|\.match\(|\.query\(/;

/** The expression that held the bad value on the failing line, its root variable, and the field read from it. */
function targetOf(kind: string, message: string, line: string): { expr: string; root: string; key: string | null } | null {
  const path = `${IDENT}(?:\\??\\.${IDENT}|\\[[^\\]]+\\]|\\([^()]*\\))*`;
  let pattern: RegExp | null = null;
  let key: string | null = null;
  if (kind === "node-undefined-access" || kind === "node-undefined-write") {
    const prop = /\((?:reading|setting) '(.*)'\)/.exec(message)?.[1];
    if (prop === undefined) return null;
    pattern = /^\d+$/.test(prop)
      ? new RegExp(`(${path})\\s*\\[\\s*${prop}\\s*\\]`)
      : new RegExp(`(${path})\\s*\\??\\.\\s*${escape(prop)}\\b`);
  } else if (kind === "python-none") {
    const attr = /has no attribute '(\w+)'/.exec(message)?.[1];
    pattern = attr !== undefined
      ? new RegExp(`(${path})\\.${attr}\\b`)
      : /not iterable/.test(message)
        ? new RegExp(`\\bin\\s+(${path})`)
        : new RegExp(`(${path})\\s*\\[`);
  } else if (kind === "python-key-error") {
    const quoted = /['"](.*)['"]\s*$/.exec(message.trim());
    key = quoted?.[1] ?? null;
    if (key === null) return null;
    pattern = new RegExp(`(${path})\\s*\\[\\s*['"]${escape(key)}['"]\\s*\\]`);
  }
  if (pattern === null) return null;
  const expr = pattern.exec(line)?.[1];
  if (expr === undefined) return null;
  const root = new RegExp(`^${IDENT}`).exec(expr)?.[0] as string;
  if (key === null && kind.startsWith("node-")) {
    // `user.profile.name` undefined: the field `profile` may be misnamed.
    const field = new RegExp(`\\.(${IDENT})$`).exec(expr)?.[1];
    if (field !== undefined) key = field;
  }
  return { expr, root, key };
}

function functionStart(
  lines: readonly string[],
  index: number,
  fnName: string,
  lang: Lang,
): { index: number; params: string[] } | null {
  const name = shortName(fnName);
  if (name === "" || name === "<module>" || name === "<anonymous>" || fnName.includes("<anonymous>")) return null;
  const n = escape(name);
  const patterns =
    lang === "python"
      ? [new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(`)]
      : [
          new RegExp(`function\\s*\\*?\\s*${n}\\s*\\(`),
          new RegExp(`\\b${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|${IDENT}\\s*=>)`),
          new RegExp(`^\\s*(?:static\\s+)?(?:async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`),
        ];
  for (let i = Math.min(index, lines.length - 1); i >= 0; i--) {
    const text = lines[i] ?? "";
    if (!patterns.some((p) => p.test(text))) continue;
    return { index: i, params: params(lines.slice(i, i + 6).join(" "), name, lang) };
  }
  return null;
}

function params(text: string, name: string, lang: Lang): string[] {
  const arrow = new RegExp(`${escape(name)}\\s*[:=]\\s*(?:async\\s*)?(${IDENT})\\s*=>`).exec(text);
  if (arrow !== null) return [arrow[1] as string];
  const open = text.indexOf("(", text.indexOf(name) + name.length);
  if (open === -1) return [];
  const inner = balanced(text, open);
  if (inner === null) return [];
  const list = splitTopLevel(inner).map((p) =>
    p.replace(/=.*$/s, "").replace(/:.*$/s, "").replace(/^[*.\s]+/, "").replace(/\?$/, "").trim(),
  );
  return lang === "python" && (list[0] === "self" || list[0] === "cls") ? list.slice(1) : list;
}

function assignment(
  lines: readonly string[],
  from: number,
  before: number,
  name: string,
  lang: Lang,
): { index: number; rhs: string } | null {
  const n = escape(name);
  const patterns =
    lang === "python"
      ? [
          new RegExp(`^\\s*(?:${IDENT}\\s*,\\s*)*${n}\\s*(?:,\\s*${IDENT}\\s*)*(?::[^=]+)?=(?!=)(.*)$`),
          new RegExp(`^\\s*(?:async\\s+)?for\\s+(?:.*\\b)?${n}\\b.*?\\s+in\\s+(.+?):\\s*$`),
          new RegExp(`\\bfor\\s+${n}\\s+in\\s+(${IDENT}(?:\\.${IDENT})*(?:\\([^()]*\\))?)\\s*(?:if\\b|[)\\]}])`),
          new RegExp(`\\bwith\\s+(.+?)\\s+as\\s+${n}\\b`),
          new RegExp(`\\b${n}\\s*:=\\s*(.+)$`),
        ]
      : [
          new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=(?!=)(.*)$`),
          new RegExp(`\\b(?:const|let|var)\\s*[{\\[][^}\\]]*\\b${n}\\b[^}\\]]*[}\\]]\\s*=(?!=)(.*)$`),
          new RegExp(`^\\s*${n}\\s*=(?!=)(.*)$`),
          new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${n}\\s+(?:of|in)\\s+(.+?)\\)`),
        ];
  for (let i = before - 1; i >= from; i--) {
    for (const p of patterns) {
      const match = p.exec(lines[i] ?? "");
      if (match !== null) return { index: i, rhs: (match[1] ?? "").trim().replace(/;$/, "") };
    }
  }
  return null;
}

/** Arguments of the first call to `name` on the line, split at top-level commas. */
function callArgs(line: string, name: string): string[] | null {
  const match = new RegExp(`(?:^|[^\\w$])${escape(name)}\\s*\\(`).exec(line);
  if (match === null) return null;
  const inner = balanced(line, match.index + match[0].length - 1);
  return inner === null ? null : splitTopLevel(inner).map((a) => a.trim());
}

function callee(expr: string): { short: string; module: string | null; awaited: boolean } | null {
  const match = /^\s*(await\s+)?(?:new\s+)?([\w$]+(?:\.[\w$]+)*)\s*\(/.exec(expr);
  if (match === null) return null;
  const parts = (match[2] as string).split(".");
  return {
    short: parts[parts.length - 1] as string,
    module: parts.length > 1 ? (parts[parts.length - 2] as string) : null,
    awaited: match[1] !== undefined,
  };
}

/** Text inside the brackets opening at `open`, or null if unbalanced on this text. */
function balanced(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const last = text.slice(start);
  if (last.trim() !== "") out.push(last);
  return out;
}

function environment(line: string): string | null {
  const match = /os\.environ(?:\.get)?|os\.getenv|process\.env|sys\.argv|\binput\(/.exec(line);
  if (match === null) return null;
  return match[0] === "sys.argv" ? "the command line" : match[0] === "input(" ? "user input" : `the environment (\`${match[0]}\`)`;
}

/** `zip(a, b[1:])`-style pairing where only one side (or each side differently) is sliced. */
function zipShift(def: Definition): { text: string; index: number; left: string; right: string } | null {
  const side = `(${IDENT}(?:\\.${IDENT})*)(\\[[^\\]]*\\])?`;
  for (let i = 0; i < def.lines.length; i++) {
    const m = new RegExp(`zip\\(\\s*${side}\\s*,\\s*${side}\\s*\\)`).exec(def.lines[i] as string);
    if (m === null || (m[2] ?? "") === (m[4] ?? "")) continue;
    return { text: m[0], index: def.start + i, left: `${m[1]}${m[2] ?? ""}`, right: `${m[3]}${m[4] ?? ""}` };
  }
  return null;
}

interface Literal {
  readonly value: string;
  readonly file: string;
  readonly index: number;
}

/** The key expression of a lookup: `m.get(key)`, `list.find(...key...)`'s call argument, `table[key]`. */
function lookupKey(expr: string): string | null {
  const path = `${IDENT}(?:\\.${IDENT})*`;
  const m =
    new RegExp(`\\.(?:get|has|findOne)\\(\\s*(${path}|"[^"]*"|'[^']*')\\s*[,)]`).exec(expr) ??
    new RegExp(`\\[\\s*(${path}|"[^"]*"|'[^']*')\\s*\\]\\s*$`).exec(expr) ??
    new RegExp(`^\\s*(?:await\\s+)?${path}\\(\\s*(${path}|"[^"]*"|'[^']*')\\s*\\)\\s*$`).exec(expr);
  return m?.[1] ?? null;
}

async function caseMismatch(
  frames: readonly TraceFrame[],
  seeds: readonly Literal[],
  files: Files,
  root: string,
  allFiles: () => Promise<readonly string[]>,
): Promise<string | null> {
  const literal = /(["'])((?:(?!\1)[^\\\n])+)\1/g;
  const onStack: Literal[] = [...seeds];
  const candidates = new Set([...frames.map((f) => f.file), ...seeds.map((s) => s.file)]);
  for (const frame of frames) {
    const line = (await files.lines(frame.file))?.[frame.line - 1] ?? "";
    for (const m of line.matchAll(literal)) onStack.push({ value: m[2] as string, file: frame.file, index: frame.line - 1 });
  }
  if (onStack.length === 0) return null;
  const sameLang = (await allFiles()).filter((f) => LANG[extname(f)] === LANG[extname(frames[0]?.file ?? "")]);
  for (const f of sameLang.slice(0, 200)) candidates.add(f);
  for (const file of candidates) {
    const lines = await files.lines(file);
    if (lines === null) continue;
    for (let i = 0; i < lines.length; i++)
      for (const m of (lines[i] ?? "").matchAll(literal)) {
        const value = m[2] as string;
        const hit = onStack.find((s) => s.value !== value && s.value.toLowerCase() === value.toLowerCase() && /\w/.test(value));
        if (hit !== undefined)
          return `**Possible case mismatch.** \`"${hit.value}"\` at \`${relative(root, hit.file)}:${hit.index + 1}\` and \`"${value}"\` at \`${relative(root, file)}:${i + 1}\` differ only in case. A lookup comparing them exactly finds nothing.`;
      }
  }
  return null;
}

async function writtenKeys(
  allFiles: readonly string[],
  files: Files,
  lang: Lang,
): Promise<{ key: string; file: string; index: number }[]> {
  const patterns =
    lang === "python"
      ? [/["'](\w+)["']\s*:/g, /\[\s*["'](\w+)["']\s*\]\s*=(?!=)/g, /\b(\w+)\s*=(?!=)[^,)]*[,)]/g]
      : [/["']?([A-Za-z_$][\w$]*)["']?\s*:(?!:)/g, /\.([A-Za-z_$][\w$]*)\s*=(?!=)/g];
  const out: { key: string; file: string; index: number }[] = [];
  for (const file of allFiles.filter((f) => LANG[extname(f)] === lang).slice(0, MAX_SCANNED_FILES)) {
    const lines = await files.lines(file);
    if (lines === null) continue;
    lines.forEach((line, index) => {
      // `dict(key=...)` keyword arguments only count inside a dict(...) call.
      patterns.forEach((p, n) => {
        if (lang === "python" && n === 2 && !/\bdict\s*\(/.test(line)) return;
        for (const m of line.matchAll(p)) out.push({ key: m[1] as string, file, index });
      });
    });
  }
  return out;
}

/**
 * The object literal that most looks like the failing value: it has at least
 * two of the other keys the stack's code reads from the traced variables, but
 * not the missing one.
 */
async function builtWithout(
  key: string,
  names: ReadonlySet<string>,
  frames: readonly TraceFrame[],
  files: Files,
  lang: Lang,
  allFiles: readonly string[],
): Promise<{ file: string; index: number; keys: string[]; shared: string[] } | null> {
  const read = new Set<string>();
  const access = (n: string) =>
    lang === "python"
      ? new RegExp(`\\b${escape(n)}(?:\\[\\s*["'](\\w+)["']\\s*\\]|\\.get\\(\\s*["'](\\w+)["'])`, "g")
      : new RegExp(`\\b${escape(n)}(?:\\??\\.(${IDENT})|\\[\\s*["'](\\w+)["']\\s*\\])`, "g");
  for (const file of new Set(frames.map((f) => f.file))) {
    const text = (await files.lines(file))?.join("\n") ?? "";
    for (const n of names) for (const m of text.matchAll(access(n))) read.add((m[1] ?? m[2]) as string);
  }
  read.delete(key);
  if (read.size < 2) return null;
  let best: { file: string; index: number; keys: string[]; shared: string[] } | null = null;
  for (const file of allFiles.filter((f) => LANG[extname(f)] === lang).slice(0, MAX_SCANNED_FILES)) {
    const text = (await files.lines(file))?.join("\n");
    if (text === undefined) continue;
    for (let pos = text.indexOf("{"); pos !== -1; pos = text.indexOf("{", pos + 1)) {
      const inner = balanced(text, pos);
      if (inner === null) continue;
      const keys = splitTopLevel(inner).flatMap((item) => {
        const m = /^\s*(?:["']([\w$]+)["']|([A-Za-z_$][\w$]*))\s*:/.exec(item);
        return m === null || (lang === "python" && m[1] === undefined) ? [] : [(m[1] ?? m[2]) as string];
      });
      if (keys.includes(key)) continue;
      const shared = keys.filter((k) => read.has(k));
      if (shared.length >= 2 && (best === null || shared.length > best.shared.length))
        best = { file, index: text.slice(0, pos).split("\n").length - 1, keys, shared };
    }
  }
  return best;
}

/** Same name modulo case and separators, one a prefix of the other, or a small edit apart. */
function similar(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 4) return false;
  if (x.startsWith(y) || y.startsWith(x)) return true;
  return Math.max(x.length, y.length) >= 6 && editDistance(x, y) <= 2;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length] as number;
}

/** "Object.handle", "async profile", "Foo.bar" → the bare function name. */
function shortName(fn: string): string {
  const name = fn.replace(/^async\s+/, "").replace(/\s*\[as \w+\]$/, "");
  return name.slice(name.lastIndexOf(".") + 1);
}

function numbered(lines: readonly string[], start: number): string[] {
  const width = String(start + lines.length).length;
  return lines.map((line, i) => `  ${String(start + i + 1).padStart(width)} | ${line}`);
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cached file reads, bounded in size; paths are already resolved inside the root. */
class Files {
  private readonly cache = new Map<string, readonly string[] | null>();
  constructor(private readonly root: string) {}

  async lines(file: string): Promise<readonly string[] | null> {
    if (!this.cache.has(file)) {
      try {
        const text = await readFile(file, "utf8");
        this.cache.set(file, text.length > MAX_FILE_BYTES ? null : text.split("\n"));
      } catch {
        this.cache.set(file, null);
      }
    }
    return this.cache.get(file) ?? null;
  }

  /**
   * The string literal an expression evaluates to, statically: a literal
   * itself, or `mod.field` where `mod` is an imported module (or a file named
   * after it) that sets `field` to a literal.
   */
  async literalOf(
    expr: string,
    file: string,
    index: number,
    allFiles: () => Promise<readonly string[]>,
  ): Promise<Literal | null> {
    const text = expr.trim();
    if (/^(["'])[^"']*\1$/.test(text)) return { value: text, file, index };
    const member = new RegExp(`^(${IDENT})\\.(${IDENT})$`).exec(text);
    if (member === null) return null;
    const [, mod, field] = member as unknown as [string, string, string];
    const source = (await this.lines(file))?.join("\n") ?? "";
    const spec =
      new RegExp(`\\b${mod}\\s*=\\s*require\\(\\s*["']([^"']+)["']`).exec(source)?.[1] ??
      new RegExp(`import\\s+(?:\\*\\s+as\\s+)?${mod}\\s+from\\s+["']([^"']+)["']`).exec(source)?.[1] ??
      mod;
    const stem = basename(spec).replace(/\.[cm]?[jt]s$|\.py$/, "");
    for (const candidate of (await allFiles()).filter((f) => basename(f, extname(f)) === stem && LANG[extname(f)] !== undefined)) {
      const lines = await this.lines(candidate);
      const at = lines?.findIndex((l) => new RegExp(`\\b${field}["']?\\s*[:=]\\s*(["'])[^"']*\\1`).test(l)) ?? -1;
      if (lines === null || at === -1) continue;
      const value = new RegExp(`\\b${field}["']?\\s*[:=]\\s*((["'])[^"']*\\2)`).exec(lines[at] as string)?.[1] as string;
      return { value, file: candidate, index: at };
    }
    return null;
  }

  /** Where `name` is defined: the same file, then `module.ext`, then any file in the language. */
  async definition(
    name: string,
    module: string | null,
    near: string,
    lang: Lang,
    allFiles: () => Promise<readonly string[]>,
  ): Promise<Definition | null> {
    const all = (await allFiles()).filter((f) => LANG[extname(f)] === lang);
    // `mod.fn(...)`: only the module's own file, so `table.get(...)` does not match some other `get`.
    const order =
      module === null ? [near, ...all.slice(0, MAX_SCANNED_FILES)] : all.filter((f) => basename(f, extname(f)) === module);
    for (const file of unique(order)) {
      if (!file.startsWith(this.root)) continue;
      const lines = await this.lines(file);
      if (lines === null) continue;
      const fn = functionStart(lines, lines.length - 1, name, lang);
      if (fn === null) continue;
      const head = lines[fn.index] ?? "";
      return {
        name,
        file,
        start: fn.index,
        lines: body(lines, fn.index, lang),
        async: /\basync\b/.test(head.slice(0, head.indexOf(name) + name.length + 20)),
      };
    }
    return null;
  }
}

/** The function starting at `start`: by indentation (Python) or by braces (JS), capped. */
function body(lines: readonly string[], start: number, lang: Lang): string[] {
  const out = [lines[start] ?? ""];
  if (lang === "python") {
    const indent = /^\s*/.exec(out[0] as string)?.[0].length ?? 0;
    for (let i = start + 1; i < lines.length && out.length < MAX_BODY_LINES; i++) {
      const line = lines[i] ?? "";
      if (line.trim() !== "" && (/^\s*/.exec(line)?.[0].length ?? 0) <= indent) break;
      out.push(line);
    }
    while (out.length > 1 && (out[out.length - 1] as string).trim() === "") out.pop();
    return out;
  }
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length && out.length <= MAX_BODY_LINES; i++) {
    const line = lines[i] ?? "";
    if (i > start) out.push(line);
    for (const c of line) {
      if (c === "{") {
        depth++;
        opened = true;
      } else if (c === "}") depth--;
    }
    if (opened && depth <= 0) break;
    if (!opened && i > start + 2) break;
  }
  return out;
}
