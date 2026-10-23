import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { traceJava } from "./traceJava.js";

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
  readonly column?: number;
  /** Local variables at the failure, when the output printed them (name to repr). */
  readonly locals?: Readonly<Record<string, string>>;
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
const MAX_CLASS_LINES = 300;
const MAX_SCANNED_FILES = 3_000;
const MAX_FILE_BYTES = 1024 * 1024;
const IDENT = "[A-Za-z_$][\\w$]*";

const NIL_KINDS = new Set(["node-undefined-access", "node-undefined-write", "python-none"]);
/** Top-level code: the whole file above the line is its scope. */
const MODULE_FRAME = /^(?:<module>|Object\.<anonymous>)$/;
const COMPREHENSION_FRAME = /^<\w*(?:expr|comp)>$/;
/** Data whose field names come from outside the codebase. */
const EXTERNAL = /\b(?:json\.loads?|JSON\.parse|yaml\.\w*load|request|req|response|res)\b|\.json\(\)/;
/** Lines longer than this are ignored: minified or generated code, and it bounds regex work. */
const MAX_LINE = 2000;

/** Inline code that survives backticks in the text. */
export function c(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  if (longest === 0) return "`" + text + "`";
  const fence = "`".repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

const OPERAND = /unsupported operand type|can only concatenate|must be str|must be real number|not supported between instances/;

interface Producer {
  readonly file: string;
  /** 0-based line index. */
  readonly index: number;
  /** The expression that produced the value (assignment right-hand side or call argument). */
  readonly expr: string;
  /** The value is one element of `expr` (a loop or comprehension target), not `expr` itself. */
  readonly element?: boolean;
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
  if (extname(crash.file) === ".java") return kind === "java-null-pointer" ? traceJava(message, frames, root, allFiles) : null;
  const lang = LANG[extname(crash.file)];
  if (lang === undefined) return null;
  const files = new Files(root);
  const crashLine = (await files.lines(crash.file))?.[crash.line - 1];
  if (crashLine === undefined) return null;

  const hypotheses: string[] = [];
  const steps: string[] = [];
  const code: TraceCode[] = [];
  const at = (file: string, index: number) => c(`${relative(root, file)}:${index + 1}`);

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
      const file = await files.moduleFile(mod, crash.file, lang, allFiles);
      const lines = file === null ? null : await files.lines(file);
      if (file === null || lines === null) continue;
      const index = lines.findIndex((l) => new RegExp(`^${name}\\s*(?::[^=]+)?=(?!=)`).test(l));
      if (index === -1) continue;
      const line = lines[index] ?? "";
      steps.push(`${c(`${mod}.${name}`)} is set at ${at(file, index)}: ${c(line.trim())}`);
      const env = environment(line);
      // Only when the error involves a str and the value is not converted where it is read.
      const converted = new RegExp(`=\\s*(?:int|float|Decimal|bool|complex)\\s*\\(`).test(line);
      if (env !== null && !converted && /'str'/.test(message))
        hypotheses.push(
          `**Environment value used as a number.** ${c(`${mod}.${name}`)} comes from ${env} at ${at(file, index)}, which is always a string. Convert it where it is read (\`int(...)\` or \`float(...)\`), not at each use.`,
        );
    }
    return hypotheses.length + steps.length === 0 ? null : { hypotheses, steps, code };
  }

  // A chained call split over lines (`user.displayName` then `.split(" ")` below it):
  // the runtime reports the `.split` line, so join it to the lines above it.
  const crashLines = (await files.lines(crash.file)) ?? [];
  let joined = crashLine;
  for (let i = crash.line - 2; i >= Math.max(0, crash.line - 5) && /^\s*\??\./.test(joined); i--)
    joined = `${(crashLines[i] ?? "").trim()}${joined.trim()}`;
  const target = targetOf(kind, message, joined, joined === crashLine ? crash.column : undefined);
  if (target === null) return null;
  steps.push(`The bad value is ${c(target.expr)} at ${at(crash.file, crash.line - 1)}.`);
  if (target.computed !== undefined)
    steps.push(`The key is computed: ${c(target.computed)} evaluated to ${c(`'${target.key}'`)} (from the KeyError message).`);

  // Follow a variable back through assignments and call arguments, from frame `from` outward.
  // Stops (says nothing more) wherever the scope is unclear, rather than guess.
  // With `throughFields`, `f(config.db)` and `const t = s.http.timeouts` keep the trace going on
  // `config` / `s`, recording the fields read from it (`path`): config objects are passed in pieces.
  const follow = async (start: string, from: number, throughFields = false) => {
    let name = start;
    let element = false;
    let path: string[] = [];
    const names = new Set([name]);
    const done = (frame: number, producer: Producer | null) => ({ name, names, frame, producer, element, path });
    // `loadConfig("prod").db`: the call is the producer, the fields read off it extend the path.
    const offCall = (expr: string): string | null => {
      if (!throughFields) return null;
      const m = new RegExp(`^([\\s\\S]*\\))((?:\\.${IDENT}|\\[\\s*["'][^"'\\]]+["']\\s*\\])+)$`).exec(expr.trim());
      if (m === null || callee(m[1] as string) === null) return null;
      const fields = fieldPath(`x${m[2]}`)?.fields;
      if (fields === undefined) return null;
      path = [...fields, ...path];
      return m[1] as string;
    };
    const throughField = (expr: string) => {
      if (!throughFields) return false;
      const member = fieldPath(expr);
      if (member === null) return false;
      name = member.root;
      path = [...member.fields, ...path];
      return true;
    };
    for (let f = from; f < frames.length; f++) {
      const frame = frames[f] as TraceFrame;
      const lines = await files.lines(frame.file);
      if (lines === null) break;
      const comprehension = COMPREHENSION_FRAME.test(frame.function);
      const moduleLevel = MODULE_FRAME.test(frame.function);
      const fn = comprehension || moduleLevel ? null : functionStart(lines, frame.line - 1, frame.function, lang);
      // A named function whose start we cannot find (anonymous callbacks, lambdas, unusual syntax).
      if (fn === null && !comprehension && !moduleLevel) break;
      // A comprehension's scope is its own line; its `for x in xs` is on that line.
      const from = fn !== null ? fn.index + 1 : comprehension ? frame.line - 1 : 0;
      let index = comprehension ? frame.line : frame.line - 1;
      let assigned = assignment(lines, from, index, name, lang);
      while (assigned !== null) {
        const text = lines[assigned.index]?.trim() ?? "";
        steps.push(
          assigned.loop
            ? `${c(name)} is an element of ${c(assigned.rhs)} (${at(frame.file, assigned.index)}).`
            : `${c(name)} is assigned at ${at(frame.file, assigned.index)}: ${c(text)}`,
        );
        element ||= assigned.loop;
        const alias = new RegExp(`^(${IDENT})$`).exec(assigned.rhs);
        if (alias === null && !assigned.loop && throughField(assigned.rhs)) {
          index = assigned.index;
          assigned = assignment(lines, from, index, name, lang);
          continue;
        }
        const produced = alias === null && !assigned.loop ? offCall(assigned.rhs) : null;
        if (produced !== null) return done(f, { file: frame.file, index: assigned.index, expr: produced, element });
        if (alias === null || names.has(alias[1] as string))
          return done(f, { file: frame.file, index: assigned.index, expr: assigned.rhs, element });
        name = alias[1] as string;
        names.add(name);
        index = assigned.index;
        assigned = assignment(lines, from, index, name, lang);
      }
      // A comprehension runs inside the next frame's function: same names.
      if (comprehension) continue;
      if (fn === null || !fn.params.includes(name)) break;
      const caller = frames[f + 1];
      const callerLine = caller === undefined ? undefined : (await files.lines(caller.file))?.[caller.line - 1];
      if (caller === undefined || callerLine === undefined) {
        steps.push(`${c(name)} is a parameter of ${c(shortName(frame.function))}; its caller is not in the stack.`);
        break;
      }
      const args = callArgs(callerLine, shortName(frame.function));
      const arg = args === null ? null : argumentFor(fn, args, name, lang);
      if (arg === null) break;
      steps.push(`${c(name)} is a parameter of ${c(shortName(frame.function))}, passed as ${c(arg)} at ${at(caller.file, caller.line - 1)}.`);
      const simple = new RegExp(`^(${IDENT})$`).exec(arg);
      if (simple === null && throughField(arg)) continue;
      const produced = simple === null ? offCall(arg) : null;
      if (produced !== null) return done(f + 1, { file: caller.file, index: caller.line - 1, expr: produced, element });
      if (simple === null) return done(f + 1, { file: caller.file, index: caller.line - 1, expr: arg, element });
      name = simple[1] as string;
      names.add(name);
    }
    return done(-1, null);
  };

  // The value is a call result on the failing line itself (`RATES.get(currency).value`), or a variable to follow.
  const chain = target.expr.endsWith(")")
    ? { name: target.expr, names: new Set<string>(), frame: 0, producer: { file: crash.file, index: crash.line - 1, expr: target.expr } as Producer | null, element: false, path: [] as string[] }
    : await follow(target.root, 0, true);
  const { name, names, producer } = chain;
  const element = producer?.element === true;
  // `order.address` or `profile["email"]` is missing, not `order`: the object exists, a field of it is empty.
  const fieldAccess = target.expr !== target.root && !target.expr.endsWith(")");

  // For a lookup, follow the key back too: its value is what failed to match.
  const seeds: Literal[] = [];
  let keyOwner: { field: string; producer: Producer } | null = null;
  const call = producer === null ? null : callee(producer.expr);
  const def = call === null || producer === null ? null : await files.definition(call.short, call.module, producer.file, lang, allFiles);
  const isLookup =
    producer !== null && !element && !fieldAccess && NIL_KINDS.has(kind) && (LOOKUP.test(producer.expr) || (def !== null && LOOKUP.test(def.lines.join("\n"))));
  const key = producer === null || !isLookup ? null : lookupKey(producer.expr);
  if (producer !== null && key !== null) {
    const simple = new RegExp(`^${IDENT}$`).test(key);
    const keyChain = simple ? await follow(key, chain.frame) : null;
    const expr = simple ? keyChain?.producer?.expr ?? null : key;
    const from = simple ? keyChain?.producer ?? null : producer;
    let literal = expr === null || from === null ? null : await files.literalOf(expr, from.file, from.index, allFiles);
    // `req.userId`: follow `req` to an object literal that sets `userId`.
    const member = expr === null ? null : new RegExp(`^(${IDENT})\\.(${IDENT})$`).exec(expr);
    if (literal === null && member !== null && from !== null) {
      const owner = await follow(member[1] as string, simple ? Math.max(keyChain?.frame ?? 0, 0) : chain.frame);
      if (owner.producer !== null) keyOwner = { field: member[2] as string, producer: owner.producer };
      const objectText = owner.producer?.expr ?? "";
      const field = new RegExp(`^\\{.*\\b${member[2]}\\s*:\\s*((["'])[^"'\\n]*\\2)`).exec(objectText);
      if (owner.producer !== null && field !== null)
        literal = { value: field[1] as string, file: owner.producer.file, index: owner.producer.index };
    }
    if (literal !== null) {
      steps.push(`The lookup key is ${c(literal.value)}${expr === literal.value ? "" : ` (${c(expr ?? "")})`}, set at ${at(literal.file, literal.index)}.`);
      seeds.push({ value: literal.value.slice(1, -1), file: literal.file, index: literal.index });
    }
  }

  if (producer !== null) {
    if (call !== null && def !== null) {
      addDefinition(def, element ? `produces the collection ${c(name)} comes from` : `produces ${c(name)}`);
      // A Promise is an object: reading a property *of* it gives undefined, but the
      // variable itself is never undefined. A NoneType error never comes from a coroutine.
      const promiseShaped =
        lang === "js" ? target.expr !== target.root && !target.expr.startsWith(`${target.root}(`) : /'coroutine' object/.test(message);
      if (def.async && !call.awaited && !element && promiseShaped)
        hypotheses.push(
          lang === "js"
            ? `**Missing \`await\`.** ${c(def.name)} is \`async\`, so ${c(producer.expr)} at ${at(producer.file, producer.index)} returns a Promise. ${c(name)} is that Promise, not the value, so ${c(target.expr)} is \`undefined\`. Likely fix: \`await\` the call.`
            : `**Missing \`await\`.** ${c(def.name)} is \`async def\`, so ${c(producer.expr)} at ${at(producer.file, producer.index)} returns a coroutine, not the value. Likely fix: \`await\` the call.`,
        );
      else if (isLookup && LOOKUP.test(def.lines.join("\n")))
        hypotheses.push(
          `**The lookup found nothing.** ${c(call.module === null ? def.name : `${call.module}.${def.name}`)} returns ${lang === "js" ? "`undefined`" : "`None`"} when no entry matches, and ${c(producer.expr)} at ${at(producer.file, producer.index)} got that. Check the key that was passed against the stored keys before guarding the crash site.`,
        );
      const shifted = zipShift(def);
      if (shifted !== null)
        hypotheses.push(
          `**Columns shifted.** ${c(shifted.text)} at ${at(def.file, shifted.index)} pairs ${c(shifted.left)} with ${c(shifted.right)}, which are sliced differently, so each key gets the next column's value${target.key === null ? "" : ` and the last key (here ${c(target.key)}) can go missing`}. Line the two sides up.`,
        );
    } else if (isLookup)
      hypotheses.push(
        `**The lookup found nothing.** ${c(producer.expr)} at ${at(producer.file, producer.index)} returns ${lang === "js" ? "`undefined`" : "`None`"} when no entry matches. Check the key it was given against the stored keys before guarding the crash site.`,
      );
  }

  // The traced lookup key differs only in case from a literal in the code.
  if (NIL_KINDS.has(kind) && seeds.length > 0) {
    const mismatch = await caseMismatch(frames, seeds, files, root, allFiles);
    if (mismatch !== null) hypotheses.push(mismatch);
  }

  // Runtime values (pytest --showlocals, Sentry frame vars): put what the read expected next to what
  // the variable actually held when it failed. Stronger than any static guess, so it goes first.
  const readMatch = producer === null || element ? null : new RegExp(`^(${IDENT}(?:\\.${IDENT})*)\\s*(?:\\.get\\(\\s*["']([^"']+)["']|\\[\\s*["']([^"']+)["']\\s*\\])`).exec(producer.expr);
  const containerOf = (expr: string) => /^(.*?)(?:\.[A-Za-z_$][\w$]*|\[\s*["'][^"']+["']\s*\])$/.exec(expr)?.[1] ?? null;
  const read =
    readMatch !== null && producer !== null
      ? { container: readMatch[1] as string, key: (readMatch[2] ?? readMatch[3]) as string, frame: Math.max(chain.frame, 0), file: producer.file, index: producer.index, text: producer.expr }
      : target.key !== null && kind === "python-key-error"
        ? { container: target.expr, key: target.key, frame: 0, file: crash.file, index: crash.line - 1, text: `${target.expr}[${target.computed ?? JSON.stringify(target.key)}]` }
        : fieldAccess && lastFieldName(target.expr) !== null && containerOf(target.expr) !== null
          ? { container: containerOf(target.expr) as string, key: lastFieldName(target.expr) as string, frame: 0, file: crash.file, index: crash.line - 1, text: target.expr }
          : null;
  // The real object decides: a static guess is dropped when the run contradicts it (the key it
  // calls missing was there) or the run already explained the failure (a wrong key).
  let runtimeKeys: ReadonlySet<string> | null = null;
  let runtimeMismatch = false;
  if (read !== null) {
    const actual = localValue(frames[read.frame]?.locals, read.container);
    const keys = actual === null ? null : keysOf(actual);
    if (actual !== null && keys !== null) {
      runtimeKeys = keys;
      const shown = `${c(read.container)} was ${c(maskValue(read.container, actual))}`;
      if (!keys.has(read.key)) {
        const near = [...keys].filter((k) => similar(k, read.key)).sort((a, b) => closeness(a, read.key) - closeness(b, read.key));
        runtimeMismatch = near.length > 0;
        hypotheses.unshift(
          near.length > 0
            ? `**Runtime value: wrong key.** At ${at(read.file, read.index)} the code reads ${c(read.text)}, but when it failed ${shown}: it has ${c(near[0] as string)}, not ${c(read.key)}.`
            : `**Runtime value: key missing.** At ${at(read.file, read.index)} the code reads ${c(read.text)}, but when it failed ${shown}, with no ${c(read.key)}. Find out why the data lacks it before defaulting it.`,
        );
      }
      // The run and the repo's samples of this data disagree about the key: a stale
      // fixture or a changed contract, worth saying whichever side is right.
      const samples = await payloadKeys(await allFiles(), files, lang, { file: read.file, index: read.index });
      const sampleExact = samples.find((k) => k.key === read.key);
      const sampleNear = samples.filter((k) => k.key !== read.key && similar(k.key, read.key));
      const runtimeNear = [...keys].find((k) => k !== read.key && similar(k, read.key));
      if (!keys.has(read.key) && runtimeNear !== undefined && sampleExact !== undefined)
        hypotheses.push(
          `**The run and the repo disagree.** When it failed, ${c(read.container)} had ${c(runtimeNear)}, but the sample at ${at(sampleExact.file, sampleExact.index)} has ${c(read.key)}. Something between them renames it (a step that transforms the keys, a changed contract), or the sample is stale.`,
        );
      else if (keys.has(read.key) && sampleExact === undefined && sampleNear.length > 0) {
        const first = sampleNear[0] as PayloadKey;
        hypotheses.push(
          `**The run and the repo disagree.** When it failed, ${c(read.container)} had ${c(read.key)}, but the sample at ${at(first.file, first.index)} spells it ${c(first.key)}. The code matches the real data; the sample may be stale.`,
        );
      }
    }
  }
  // The values of the traced variables, as printed by the failing run.
  const printed = [...new Set([target.root, ...names, ...(read !== null && /^[A-Za-z_$][\w$]*$/.test(read.container) ? [read.container] : [])])].flatMap((n) => {
    const frame = frames.find((f) => f.locals?.[n] !== undefined);
    return frame === undefined ? [] : [`${c(n)} = ${c(maskValue(n, frame.locals?.[n] as string))}`];
  });
  if (printed.length > 0) steps.push(`Values when it failed (printed by the failing run): ${printed.join(", ")}.`);

  // The missing value is a field of data that came from somewhere (an API, a webhook, a file): find
  // where the field is set and which key of that data it reads, then check the repo's samples of the
  // data (JSON fixtures, schemas, JSON in code) for that key. Silent unless the key is absent and a
  // near-miss name is present.
  const lastField = new RegExp(`(?:\\.(${IDENT})|\\[\\s*["']([^"'\\]]+)["']\\s*\\])$`).exec(target.expr);
  const fieldTarget =
    fieldAccess && producer !== null && lastField !== null
      ? { field: (lastField[1] ?? lastField[2]) as string, producer }
      : keyOwner;
  let payloadMismatch = false;
  if (fieldTarget !== null && !runtimeMismatch) {
    const origin = await files.fieldOrigin(fieldTarget.field, fieldTarget.producer, lang, allFiles);
    if (origin !== null && runtimeKeys?.has(origin.key) !== true) {
      steps.push(`${c(fieldTarget.field)} is set from ${c(origin.read)} at ${at(origin.file, origin.index)}.`);
      const data = await payloadKeys(await allFiles(), files, lang, origin);
      const exact = data.some((k) => k.key === origin.key);
      const near = exact ? [] : data.filter((k) => similar(k.key, origin.key)).sort((a, b) => closeness(a.key, origin.key) - closeness(b.key, origin.key));
      if (near.length > 0) {
        payloadMismatch = true;
        const shown = unique(near.map((k) => k.key)).slice(0, 2).map((key) => {
          const first = near.find((k) => k.key === key) as PayloadKey;
          return `${c(key)} (${at(first.file, first.index)})`;
        });
        // The most specific lead goes first.
        hypotheses.unshift(
          `**Field name mismatch.** ${c(fieldTarget.field)} is read from ${c(origin.read)} at ${at(origin.file, origin.index)}, but no data sample in the project has ${c(origin.key)}; it has ${shown.join(" and ")}. If that is this data, read the key it actually uses rather than defaulting the missing value.`,
        );
      }
    }
  }

  // A config object built by a shallow merge: a later source that sets a top-level key replaces it
  // whole, dropping the nested keys an earlier source had under it.
  const lastName = fieldAccess ? lastFieldName(target.expr) : null;
  const fullPath = [...chain.path, ...(lastName !== null ? [lastName] : kind === "python-key-error" && target.key !== null ? [target.key] : [])];
  if (producer !== null && def !== null && fullPath.length >= 2) {
    const dropped = await files.shallowMergeDrop(def, fullPath, lang, allFiles);
    if (dropped !== null) {
      const where = fullPath.slice(0, -1).join(".");
      const missing = fullPath.at(-1) as string;
      steps.push(`${c(name)} comes from ${c(producer.expr)}, built by the merge ${c(dropped.merge)} at ${at(def.file, dropped.mergeIndex)}.`);
      hypotheses.unshift(
        `**Shallow merge drops a nested key.** ${c(dropped.merge)} at ${at(def.file, dropped.mergeIndex)} replaces whole top-level values. The source at ${at(dropped.override.file, dropped.override.index)} sets ${c(where)} without ${c(missing)}, so ${c(`${where}.${missing}`)} from ${at(dropped.base.file, dropped.base.index)} is lost. Merge nested objects deeply, or set ${c(missing)} in that override.`,
      );
    }
  }

  // A field the code reads that the code building the value spells differently.
  // Not for `this`/`self` (their fields are set piecemeal) or data from outside (JSON, requests).
  const selfRooted = ["this", "self"].includes(target.root);
  const external = producer !== null && EXTERNAL.test(producer.expr);
  const fieldNames = new Set([...names].filter((n) => n !== "this" && n !== "self"));
  const builder =
    target.key === null || selfRooted || external || payloadMismatch || runtimeMismatch || runtimeKeys?.has(target.key) === true ? null : await builtWithout(target.key, fieldNames, frames, files, lang, await allFiles());
  const builderNear = builder === null ? [] : builder.keys.filter((k) => similar(k, target.key as string));
  if (builder !== null && builderNear.length > 0) {
    hypotheses.push(
      `**Field name mismatch.** The ${lang === "python" ? "dict" : "object"} built at ${at(builder.file, builder.index)} has ${builder.shared.map((k) => c(k)).join(", ")}, which this code also reads, but no ${c(target.key as string)}; it has ${builderNear.map((k) => c(k)).join(", ")} instead. The code that builds it and the code that reads it disagree on the name: fix one side rather than defaulting the missing key.`,
    );
  } else if (target.key !== null && !selfRooted && !external && !payloadMismatch && !runtimeMismatch && runtimeKeys?.has(target.key) !== true) {
    const keys = await writtenKeys(await allFiles(), files, lang);
    const exact = keys.filter((k) => k.key === target.key);
    const near = keys.filter((k) => k.key !== target.key && similar(k.key, target.key as string));
    if (exact.length === 0 && near.length > 0) {
      const list = unique(near.map((k) => `${c(k.key)} (${at(k.file, k.index)})`)).slice(0, 3).join(", ");
      hypotheses.push(
        `**Field name mismatch.** No code under the source root writes ${c(target.key)}, but ${list} ${near.length === 1 ? "is" : "are"} written. The code that builds this ${lang === "python" ? "dict" : "object"} and the code that reads it probably disagree on the name; fix one side rather than defaulting the missing key.`,
      );
    }
  }

  return { hypotheses, steps, code };
}

const LOOKUP = /\.find\(|\.get\(|\.findOne\(|\.first\(|\.filter\(|\.search\(|\.match\(|\.query\(/;

/** The expression that held the bad value on the failing line, its root variable, and the field read from it. */
interface Target {
  readonly expr: string;
  readonly root: string;
  readonly key: string | null;
  /** The key expression when the code computes it (`prefix + "_ref"`); `key` is then the evaluated key. */
  readonly computed?: string;
}

function targetOf(kind: string, message: string, line: string, column?: number): Target | null {
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
  // Several candidates on one line (`${a.name} ${b.name}`): the runtime's column picks the one that failed.
  const matches = [...line.matchAll(new RegExp(pattern.source, "g"))];
  const pick =
    column === undefined || matches.length < 2
      ? matches[0]
      : matches.reduce((best, m) =>
          Math.abs((m.index ?? 0) + m[0].length - column) < Math.abs((best.index ?? 0) + best[0].length - column) ? m : best,
        );
  const expr = pick?.[1];
  if (expr === undefined) return kind === "python-key-error" && key !== null ? computedKey(line, key) : null;
  const root = new RegExp(`^${IDENT}`).exec(expr)?.[0] as string;
  if (key === null && kind.startsWith("node-")) {
    // `user.profile.name` undefined: the field `profile` may be misnamed.
    const field = new RegExp(`\\.(${IDENT})$`).exec(expr)?.[1];
    if (field !== undefined) key = field;
  }
  return { expr, root, key };
}

/**
 * `record[prefix + "_ref"]` raised `KeyError: 'billing_ref'`: the key is computed, and the
 * runtime already evaluated it. Find the subscript on the line whose key is an expression,
 * preferring the one whose literal pieces ("_ref") appear in the evaluated key. Null when
 * no subscript fits or several do equally well: say nothing rather than guess.
 */
function computedKey(line: string, key: string): Target | null {
  const candidates: { expr: string; computed: string }[] = [];
  for (const m of line.matchAll(new RegExp(`(${IDENT}(?:\\??\\.${IDENT})*)\\s*\\[`, "g"))) {
    const inner = balanced(line, (m.index ?? 0) + m[0].length - 1);
    if (inner === null || /^\s*(["'])[^"']*\1\s*$|^\s*-?\d+\s*$/.test(inner)) continue;
    candidates.push({ expr: m[1] as string, computed: inner.trim() });
  }
  const pieces = (computed: string) =>
    [...computed.matchAll(/(["'])((?:(?!\1).)*)\1/g)].flatMap((m) => (m[2] as string).split(/\{[^}]*\}/)).filter((p) => p !== "");
  const fitting = candidates.filter((c) => pieces(c.computed).every((p) => key.includes(p)));
  const withPieces = fitting.filter((c) => pieces(c.computed).length > 0);
  const chosen = withPieces.length === 1 ? withPieces[0] : fitting.length === 1 ? fitting[0] : undefined;
  if (chosen === undefined) return null;
  return { expr: chosen.expr, root: new RegExp(`^${IDENT}`).exec(chosen.expr)?.[0] as string, key, computed: chosen.computed };
}

interface FunctionHead {
  readonly index: number;
  readonly params: readonly string[];
  /** Position of the first `*args`, `**kw`, bare `*` or `...rest`; -1 if none. */
  readonly rest: number;
}

function functionStart(lines: readonly string[], index: number, fnName: string, lang: Lang): FunctionHead | null {
  const name = shortName(fnName);
  if (name === "" || name.includes("<")) return null;
  const n = escape(name);
  const generics = "(?:<[^>()]*>)?";
  const patterns =
    lang === "python"
      ? [new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(`)]
      : [
          new RegExp(`function\\s*\\*?\\s*${n}\\s*${generics}\\s*\\(`),
          new RegExp(`\\b${n}\\s*(?::[^=]+)?[:=]\\s*(?:async\\s*)?(?:function\\b|${generics}\\s*\\([^)]*\\)\\s*(?::[^=]+)?=>|${IDENT}\\s*=>)`),
          new RegExp(
            `^\\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\\s+)*\\*?${n}\\s*${generics}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{`,
          ),
        ];
  for (let i = Math.min(index, lines.length - 1); i >= 0; i--) {
    const text = lines[i] ?? "";
    if (!patterns.some((p) => p.test(text))) continue;
    return { index: i, ...params(lines.slice(i, i + 6).join(" "), name, lang) };
  }
  return null;
}

function params(text: string, name: string, lang: Lang): { params: string[]; rest: number } {
  const arrow = new RegExp(`${escape(name)}\\s*[:=]\\s*(?:async\\s*)?(${IDENT})\\s*=>`).exec(text);
  if (arrow !== null) return { params: [arrow[1] as string], rest: -1 };
  const open = text.indexOf("(", text.indexOf(name) + name.length);
  if (open === -1) return { params: [], rest: -1 };
  const inner = balanced(text, open);
  if (inner === null) return { params: [], rest: -1 };
  // TypeScript types can hold commas: `opts: Record<string, string>`.
  let raw = splitTopLevel(inner, lang === "js").map((p) => p.trim());
  if (lang === "python" && (raw[0] === "self" || raw[0] === "cls")) raw = raw.slice(1);
  const rest = raw.findIndex((p) => /^(?:\*|\.\.\.)/.test(p));
  const list = raw.map((p) =>
    p.replace(/=.*$/s, "").replace(/:.*$/s, "").replace(/^[*.\s]+/, "").replace(/\?$/, "").trim(),
  );
  return { params: list, rest };
}

/**
 * The argument a caller passed for parameter `name`: a keyword argument
 * `name=...` (Python), else the positional one. Null when it cannot be told
 * (keyword-only parameter, `*args`/spread before it, missing argument).
 */
function argumentFor(fn: FunctionHead, args: readonly string[], name: string, lang: Lang): string | null {
  const position = fn.params.indexOf(name);
  if (position === -1) return null;
  if (lang === "python") {
    const keyword = args.find((a) => new RegExp(`^${escape(name)}\\s*=(?!=)`).test(a));
    if (keyword !== undefined) return keyword.replace(/^[^=]*=/, "").trim();
    if (fn.rest !== -1 && fn.rest <= position) return null;
  }
  const positional = lang === "python" ? args.filter((a) => !new RegExp(`^${IDENT}\\s*=(?!=)`).test(a)) : args;
  if (positional.slice(0, position + 1).some((a) => /^(?:\*|\.\.\.)/.test(a))) return null;
  return positional[position]?.trim() ?? null;
}

function assignment(
  lines: readonly string[],
  from: number,
  before: number,
  name: string,
  lang: Lang,
): { index: number; rhs: string; loop: boolean } | null {
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
      if (match !== null) return { index: i, rhs: (match[1] ?? "").trim().replace(/;$/, ""), loop: /\bfor\b/.test(p.source) };
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
export function balanced(text: string, open: number): string | null {
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

export function splitTopLevel(text: string, angles = false): string[] {
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
    else if (c === "(" || c === "[" || c === "{" || (angles && c === "<")) depth++;
    else if (c === ")" || c === "]" || c === "}" || (angles && c === ">" && text[i - 1] !== "=")) depth--;
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
  return match[0] === "sys.argv" ? "the command line" : match[0] === "input(" ? "user input" : `the environment (${c(match[0])})`;
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
          return `**Possible case mismatch.** The lookup key ${c(`"${hit.value}"`)} at ${c(`${relative(root, hit.file)}:${hit.index + 1}`)} and ${c(`"${value}"`)} at ${c(`${relative(root, file)}:${i + 1}`)} differ only in case. A lookup comparing them exactly finds nothing.`;
      }
  }
  return null;
}

/** `config.db` or `cfg["cache"]["ttl"]`: the root variable and the fields read from it; null for anything else. */
function fieldPath(expr: string): { root: string; fields: string[] } | null {
  const m = new RegExp(`^(${IDENT})((?:\\.${IDENT}|\\[\\s*["'][^"'\\]]+["']\\s*\\])+)$`).exec(expr.trim());
  if (m === null) return null;
  const fields = [...(m[2] as string).matchAll(new RegExp(`\\.(${IDENT})|\\[\\s*["']([^"'\\]]+)["']\\s*\\]`, "g"))].map((f) => (f[1] ?? f[2]) as string);
  return { root: m[1] as string, fields };
}

/** An object or dict literal's keys, with nested literals as nested shapes (null for any other value). */
type Shape = Map<string, Shape | null>;

/** Nesting beyond this is not parsed (a crafted file could otherwise exhaust the stack). */
const MAX_SHAPE_DEPTH = 16;

function parseShape(inner: string, lang: Lang, depth = 0): Shape {
  const shape: Shape = new Map();
  if (depth > MAX_SHAPE_DEPTH) return shape;
  for (const item of splitTopLevel(inner)) {
    const m = (lang === "python" ? /^\s*(["'])([^"']+)\1\s*:\s*([\s\S]*)$/ : /^\s*(["']?)([A-Za-z_$][\w$]*)\1\s*:\s*([\s\S]*)$/).exec(item);
    if (m === null) continue;
    const value = (m[3] as string).trim();
    const nested = value.startsWith("{") ? balanced(value, 0) : null;
    shape.set(m[2] as string, nested === null ? null : parseShape(nested, lang, depth + 1));
  }
  return shape;
}

function lastFieldName(expr: string): string | null {
  const m = new RegExp(`(?:\\.(${IDENT})|\\[\\s*["']([^"'\\]]+)["']\\s*\\])$`).exec(expr);
  return m === null ? null : ((m[1] ?? m[2]) as string);
}

/** The printed value of `expr` (`order`, or `req.body` inside a JSON value) from a frame's locals. */
function localValue(locals: Readonly<Record<string, string>> | undefined, expr: string): string | null {
  if (locals === undefined) return null;
  const [root, ...path] = expr.split(".");
  let value = locals[root as string];
  if (value === undefined) return null;
  for (const part of path) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || typeof parsed !== "object" || !(part in parsed)) return null;
      value = JSON.stringify((parsed as Record<string, unknown>)[part]);
    } catch {
      return null;
    }
  }
  return value;
}

/** Top-level keys of a printed dict, JSON object or `Class(field=...)` repr; null if it is none of those. */
function keysOf(value: string): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return new Set(Object.keys(parsed));
  } catch {}
  const text = value.trim();
  const open = text.indexOf(text.startsWith("{") ? "{" : "(");
  if (open === -1 || !/^(?:\{|[A-Za-z_][\w.]*\()/.test(text)) return null;
  const inner = balanced(text, open);
  if (inner === null) return null;
  const keys = splitTopLevel(inner).flatMap((item) => {
    const m = /^\s*(?:(['"])(.*?)\1\s*:|([A-Za-z_]\w*)\s*=)/.exec(item);
    return m === null ? [] : [(m[2] ?? m[3]) as string];
  });
  return new Set(keys);
}

const SECRET_NAME = /pass(?:word|wd)?|secret|token|api[_-]?key|auth|cookie|session|credential|private|signature/i;
/** Values that look like credentials whatever their key: provider prefixes and long random strings. */
const SECRET_VALUE = /(['"])(?:sk|pk|rk|ghp|gho|ghs|glpat|xox[abps]|AKIA|ASIA|eyJ)[\w.-]{6,}\1|(['"])[A-Za-z0-9+/=_-]{32,}\2/g;
const MAX_VALUE = 200;

/**
 * A printed value made safe to show: masked whole if its name looks secret,
 * secret-looking keys and credential-shaped strings inside it masked, and cut
 * to MAX_VALUE characters.
 */
export function maskValue(name: string, value: string): string {
  if (SECRET_NAME.test(name)) return "***";
  const masked = value
    .replace(/((['"])([^'"]*)\2\s*:\s*|\b([A-Za-z_]\w*)\s*=\s*)(['"])(?:(?!\5).)*\5/g, (whole, lead: string, _q: string, key: string | undefined, attr: string | undefined, quote: string) =>
      SECRET_NAME.test(key ?? attr ?? "") ? `${lead}${quote}***${quote}` : whole,
    )
    .replace(SECRET_VALUE, (whole) => `${whole[0]}***${whole[0]}`);
  return masked.length > MAX_VALUE ? `${masked.slice(0, MAX_VALUE - 1)}…` : masked;
}

interface ShapeAt {
  readonly shape: Shape;
  readonly file: string;
  readonly index: number;
}

/**
 * A shallow merge in a function body and its sources in merge order:
 * `Object.assign({}, a, b)`, `{ ...a, ...b }`, `{**a, **b}`, `dict(a, **b)`, `a.update(b)`.
 * Null when there is none. A call to a deep-merge helper is not matched.
 */
function shallowMerge(def: Definition, lang: Lang): { text: string; index: number; sources: string[] } | null {
  for (let i = 0; i < def.lines.length; i++) {
    const line = def.lines[i] as string;
    const text = def.lines.slice(i, i + 8).join("\n");
    if (lang === "js") {
      const assign = /Object\.assign\s*\(/.exec(line);
      if (assign !== null) {
        const inner = balanced(text, text.indexOf("(", assign.index));
        if (inner === null) continue;
        const args = splitTopLevel(inner).map((a) => a.trim());
        const sources = /^\{\s*\}$/.test(args[0] ?? "") ? args.slice(1) : args;
        if (sources.length >= 2) return { text: `Object.assign(${inner.replace(/\s+/g, " ").trim()})`, index: def.start + i, sources };
      }
    }
    const open = line.search(lang === "js" ? /\{\s*\.\.\./ : /\{\s*\*\*/);
    if (open !== -1) {
      const inner = balanced(text, open);
      if (inner === null) continue;
      const marker = lang === "js" ? "..." : "**";
      const sources = splitTopLevel(inner).map((a) => a.trim()).filter((a) => a.startsWith(marker)).map((a) => a.slice(marker.length));
      if (sources.length >= 2) return { text: `{${inner.replace(/\s+/g, " ").trim()}}`, index: def.start + i, sources };
    }
    if (lang === "python") {
      const dictCall = /\bdict\s*\(/.exec(line);
      const inner = dictCall === null ? null : balanced(text, text.indexOf("(", dictCall.index));
      if (inner !== null) {
        const sources = splitTopLevel(inner).map((a) => a.trim().replace(/^\*\*/, "")).filter((a) => !/=/.test(a));
        if (sources.length >= 2) return { text: `dict(${inner.trim()})`, index: def.start + i, sources };
      }
      const update = new RegExp(`\\b(${IDENT})\\.update\\(\\s*([^)]+?)\\s*\\)`).exec(line);
      if (update !== null) return { text: update[0], index: def.start + i, sources: [update[1] as string, update[2] as string] };
    }
  }
  return null;
}

interface PayloadKey {
  readonly key: string;
  readonly file: string;
  readonly index: number;
}

/** Config and tooling files, not samples of data the program receives. */
const NOT_PAYLOAD = /(?:^|[\\/])(?:package(?:-lock)?|tsconfig[\w.-]*|jsconfig|composer|\.?eslintrc[\w.-]*|renovate|lerna|turbo|vercel|firebase|app)\.json$|(?:^|[\\/])(?:docker-compose|\.?github|pnpm-lock|\.?gitlab-ci)[\w.-]*\.ya?ml$/;

/**
 * Keys of the data samples in the project: every object key in JSON files,
 * keys in YAML files (OpenAPI schemas, fixtures), and quoted keys in code
 * (JSON held in strings, dict literals), except on the line `skip` that reads the field.
 */
async function payloadKeys(allFiles: readonly string[], files: Files, lang: Lang, skip: { file: string; index: number }): Promise<PayloadKey[]> {
  const out: PayloadKey[] = [];
  for (const file of allFiles.slice(0, MAX_SCANNED_FILES)) {
    const ext = extname(file).toLowerCase();
    const isData = ext === ".json" || ext === ".yaml" || ext === ".yml";
    if (!isData && LANG[ext] !== lang) continue;
    if (isData && NOT_PAYLOAD.test(file)) continue;
    const lines = await files.lines(file);
    if (lines === null) continue;
    const pattern = ext === ".yaml" || ext === ".yml" ? /^\s*-?\s*["']?([A-Za-z_][\w-]*)["']?\s*:/g : /["']([A-Za-z_][\w-]*)["']\s*:/g;
    lines.forEach((line, index) => {
      if (file === skip.file && index === skip.index) return;
      for (const m of line.matchAll(pattern)) out.push({ key: m[1] as string, file, index });
    });
  }
  return out;
}

/** 0 for the same name modulo case and separators, 1 for a prefix, 2 for a small edit. */
function closeness(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
  return norm(a) === norm(b) ? 0 : norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a)) ? 1 : 2;
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

export function numbered(lines: readonly string[], start: number): string[] {
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
export class Files {
  private readonly cache = new Map<string, readonly string[] | null>();
  constructor(private readonly root: string) {}

  async lines(file: string): Promise<readonly string[] | null> {
    if (!this.cache.has(file)) {
      try {
        // Check the size first: the file is only read when it is under the cap.
        if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error("too large");
        const text = await readFile(file, "utf8");
        this.cache.set(file, text.length > MAX_FILE_BYTES ? null : text.split("\n").map((line) => (line.length > MAX_LINE ? "" : line)));
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

  /**
   * The file a module name refers to from `near`: its `require`/`import`
   * specifier resolved relative to `near` (JS) or as a dotted path (Python),
   * else a file named after it. Null when that is ambiguous.
   */
  async moduleFile(mod: string, near: string, lang: Lang, allFiles: () => Promise<readonly string[]>): Promise<string | null> {
    const source = (await this.lines(near))?.join("\n") ?? "";
    const m = escape(mod);
    const spec =
      lang === "js"
        ? new RegExp(`\\b${m}\\s*=\\s*require\\(\\s*["']([^"']+)["']`).exec(source)?.[1] ??
          new RegExp(`import\\s+(?:\\*\\s+as\\s+)?${m}\\s+from\\s+["']([^"']+)["']`).exec(source)?.[1] ??
          null
        : new RegExp(`^\\s*from\\s+([\\w.]+)\\s+import\\s+(?:.*,\\s*)?${m}\\b`, "m").exec(source)?.[1]?.concat(`.${mod}`) ??
          new RegExp(`^\\s*import\\s+([\\w.]*\\b${m})\\b`, "m").exec(source)?.[1] ??
          null;
    return this.resolveSpec(spec ?? mod, near, lang, allFiles);
  }

  /** The file a function imported by name comes from: `from x import name`, `{ name } = require("./x")`, `import { name } from "./x"`. */
  private async importedFrom(name: string, near: string, lang: Lang, allFiles: () => Promise<readonly string[]>): Promise<string | null | undefined> {
    const source = (await this.lines(near))?.join("\n") ?? "";
    const n = escape(name);
    const spec =
      lang === "js"
        ? new RegExp(`\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=\\s*require\\(\\s*["']([^"']+)["']`).exec(source)?.[1] ??
          new RegExp(`import\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`).exec(source)?.[1] ??
          new RegExp(`(?:const|let|var)\\s+${n}\\s*=\\s*require\\(\\s*["']([^"']+)["']`).exec(source)?.[1] ??
          new RegExp(`import\\s+${n}\\s+from\\s*["']([^"']+)["']`).exec(source)?.[1]
        : new RegExp(`^\\s*from\\s+([\\w.]+)\\s+import\\s+[^\\n]*\\b${n}\\b`, "m").exec(source)?.[1];
    // undefined: not imported at all; null: imported from something we cannot resolve (a package).
    return spec === undefined ? undefined : this.resolveSpec(spec, near, lang, allFiles);
  }

  private async resolveSpec(spec: string, near: string, lang: Lang, allFiles: () => Promise<readonly string[]>): Promise<string | null> {
    const all = (await allFiles()).filter((f) => LANG[extname(f)] === lang);
    if (lang === "js" && spec.startsWith(".")) {
      const base = join(dirname(near), spec);
      // TypeScript ESM imports name the emitted file: "./db.js" is db.ts, "./x.mjs" is x.mts.
      const stem = base.replace(/\.[cm]?jsx?$/, "");
      return (
        all.find((f) => f === base) ??
        all.find((f) => f.replace(/\.[cm]?[jt]sx?$/, "") === base || f.replace(/\/index\.[cm]?[jt]sx?$/, "") === base) ??
        all.find((f) => f.replace(/\.[cm]?tsx?$/, "") === stem) ??
        null
      );
    }
    if (lang === "js") return null; // a package from node_modules
    const tail = `${sep}${spec.replace(/^\.+/, "").split(".").join(sep)}.py`;
    const found = all.filter((f) => f.endsWith(tail) || basename(f) === `${spec.split(".").pop()}.py`);
    const exact = found.filter((f) => f.endsWith(tail));
    return (exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null) ?? null;
  }

  /**
   * Where `name` is defined, as seen from `near`: `mod.fn` in the module `mod`
   * refers to; a bare `fn` in `near` itself, else where `near` imports it from,
   * else the one file in the project that defines it (none if several do).
   */
  async definition(
    name: string,
    module: string | null,
    near: string,
    lang: Lang,
    allFiles: () => Promise<readonly string[]>,
  ): Promise<Definition | null> {
    let order: string[];
    if (module !== null) {
      // `Order.from_payload(...)`: `Order` may be an imported class rather than a module.
      const file = (await this.moduleFile(module, near, lang, allFiles)) ?? (await this.importedFrom(module, near, lang, allFiles)) ?? null;
      order = file === null ? [] : [file];
    } else {
      const imported = await this.importedFrom(name, near, lang, allFiles);
      order = imported === undefined ? [near] : imported === null ? [] : [imported];
    }
    for (const file of order) {
      const found = await this.defineIn(file, name, lang);
      if (found !== null) return found;
    }
    if (module !== null || order.length !== 1 || order[0] !== near) return null;
    // Not defined locally and not imported (a global, or a JS method): only an unambiguous match.
    const all = (await allFiles()).filter((f) => LANG[extname(f)] === lang).slice(0, MAX_SCANNED_FILES);
    const matches: Definition[] = [];
    for (const file of all) {
      if (file === near) continue;
      const found = await this.defineIn(file, name, lang);
      if (found !== null) matches.push(found);
      if (matches.length > 1) return null;
    }
    return matches[0] ?? null;
  }

  /**
   * Where `field` of the value `producer` returns is set, and the key of the
   * incoming data it reads: `address=payload.get("shipping_address")` in the
   * called function, `this.displayName = raw.displayName` in the constructed
   * class, `amountDue: body.amountDue` in a mapper's object literal.
   */
  async fieldOrigin(
    field: string,
    producer: Producer,
    lang: Lang,
    allFiles: () => Promise<readonly string[]>,
  ): Promise<{ key: string; read: string; file: string; index: number } | null> {
    const call = callee(producer.expr);
    if (call === null) return null;
    const regions: { file: string; start: number; lines: readonly string[] }[] = [];
    const def = await this.definition(call.short, call.module, producer.file, lang, allFiles);
    if (def !== null) regions.push({ file: def.file, start: def.start, lines: def.lines });
    const className = call.module !== null && /^[A-Z]/.test(call.module) ? call.module : /^[A-Z]/.test(call.short) ? call.short : null;
    if (className !== null) {
      const cls = await this.classRegion(className, producer.file, lang, allFiles);
      if (cls !== null) regions.push(cls);
    }
    const f = escape(field);
    const source = `(${IDENT}(?:\\.${IDENT})*)`;
    const patterns =
      lang === "python"
        ? [
            new RegExp(`(?:^|[\\s(,])(?:self\\.)?${f}\\s*=(?!=)\\s*(${source}\\.get\\(\\s*["']([^"']+)["'][^)]*\\))`),
            new RegExp(`(?:^|[\\s(,])(?:self\\.)?${f}\\s*=(?!=)\\s*(${source}\\[\\s*["']([^"']+)["']\\s*\\])`),
            new RegExp(`["']${f}["']\\s*:\\s*(${source}\\.get\\(\\s*["']([^"']+)["'][^)]*\\))`),
            new RegExp(`["']${f}["']\\s*:\\s*(${source}\\[\\s*["']([^"']+)["']\\s*\\])`),
          ]
        : [
            new RegExp(`\\bthis\\.${f}\\s*=(?!=)\\s*(${IDENT}\\??\\.(${IDENT}))\\b(?!\\s*[(.])`),
            new RegExp(`\\bthis\\.${f}\\s*=(?!=)\\s*(${IDENT}\\[\\s*["']([^"']+)["']\\s*\\])`),
            new RegExp(`(?:^|[{,\\s])["']?${f}["']?\\s*:\\s*(${IDENT}\\??\\.(${IDENT}))\\b(?!\\s*[(.])`),
            new RegExp(`(?:^|[{,\\s])["']?${f}["']?\\s*:\\s*(${IDENT}\\[\\s*["']([^"']+)["']\\s*\\])`),
          ];
    for (const region of regions)
      for (let i = 0; i < region.lines.length; i++)
        for (const p of patterns) {
          const m = p.exec(region.lines[i] as string);
          if (m === null) continue;
          const key = (lang === "python" ? m[3] : m[2]) as string;
          return { key, read: (m[1] as string).trim(), file: region.file, index: region.start + i };
        }
    return null;
  }

  /** The body of `class name`, from the file `near` imports it from, `near` itself, or the one file that defines it. */
  private async classRegion(
    name: string,
    near: string,
    lang: Lang,
    allFiles: () => Promise<readonly string[]>,
  ): Promise<{ file: string; start: number; lines: readonly string[] } | null> {
    const imported = await this.importedFrom(name, near, lang, allFiles);
    const head = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?class\\s+${escape(name)}\\b`);
    const candidates = imported === undefined ? [near] : imported === null ? [] : [imported];
    if (imported === undefined) {
      const all = (await allFiles()).filter((f) => LANG[extname(f)] === lang && f !== near).slice(0, MAX_SCANNED_FILES);
      const defining: string[] = [];
      for (const file of all) if ((await this.lines(file))?.some((l) => head.test(l))) defining.push(file);
      if (defining.length === 1) candidates.push(defining[0] as string);
    }
    for (const file of candidates) {
      const lines = await this.lines(file);
      const start = lines?.findIndex((l) => head.test(l)) ?? -1;
      if (lines === null || start === -1) continue;
      return { file, start, lines: body(lines, start, lang, MAX_CLASS_LINES) };
    }
    return null;
  }

  /**
   * A shallow merge in `def` that loses the last key of `path`: an earlier source has
   * path[0]...path[-2] holding the key, a later source sets path[0] without it. Sources are
   * resolved statically (required modules, module attributes, local variables, ternaries);
   * null when the merge is not shallow, a source cannot be resolved, or nothing is lost.
   */
  async shallowMergeDrop(
    def: Definition,
    path: readonly string[],
    lang: Lang,
    allFiles: () => Promise<readonly string[]>,
  ): Promise<{ merge: string; mergeIndex: number; base: ShapeAt; override: ShapeAt } | null> {
    const merge = shallowMerge(def, lang);
    if (merge === null) return null;
    const resolved: ShapeAt[][] = [];
    for (const source of merge.sources) resolved.push(await this.shapesOf(source, def, lang, allFiles));
    const holds = (shape: Shape, keys: readonly string[]): boolean | null => {
      let at: Shape | null | undefined = shape;
      for (const key of keys) {
        if (!(at instanceof Map)) return null;
        at = at.get(key);
        if (at === undefined) return false;
      }
      return true;
    };
    const container = path.slice(0, -1);
    for (let later = resolved.length - 1; later > 0; later--)
      for (const override of resolved[later] as ShapeAt[]) {
        if (!override.shape.has(path[0] as string) || holds(override.shape, path) !== false) continue;
        for (let earlier = later - 1; earlier >= 0; earlier--)
          for (const base of resolved[earlier] as ShapeAt[])
            if (holds(base.shape, path) === true && holds(base.shape, container) === true)
              return {
                merge: merge.text,
                mergeIndex: merge.index,
                base: { ...base, index: await this.keyLine(base, path[0] as string) },
                override: { ...override, index: await this.keyLine(override, path[0] as string) },
              };
      }
    return null;
  }

  /** The line that sets `key` in the literal starting at `at.index`, else the literal's first line. */
  private async keyLine(at: ShapeAt, key: string): Promise<number> {
    const lines = (await this.lines(at.file)) ?? [];
    const pattern = new RegExp(`(?:^|[{,\\s])["']?${escape(key)}["']?\\s*:`);
    for (let i = at.index; i < Math.min(lines.length, at.index + 200); i++) if (pattern.test(lines[i] as string)) return i;
    return at.index;
  }

  /** The literal shapes a merge source can be: `require("./x")`, `mod.NAME`, a variable assigned one, or a ternary of them. */
  private async shapesOf(expr: string, def: Definition, lang: Lang, allFiles: () => Promise<readonly string[]>, depth = 0): Promise<ShapeAt[]> {
    if (depth > 3) return [];
    const text = expr.trim();
    const out: ShapeAt[] = [];
    if (text.startsWith("{")) {
      const inner = balanced(text, 0);
      return inner === null || inner.trim() === "" ? [] : [{ shape: parseShape(inner, lang), file: def.file, index: def.start }];
    }
    // require("./x") anywhere in the expression (also inside a ternary).
    for (const m of text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      const file = await this.resolveSpec(m[1] as string, def.file, lang, allFiles);
      const exported = file === null ? null : await this.literalIn(file, lang === "js" ? /(?:module\.exports|export\s+default)\s*=?\s*\{/ : null);
      if (exported !== null) out.push(exported);
    }
    // Python module attributes: mod.NAME.
    if (lang === "python")
      for (const m of text.matchAll(new RegExp(`\\b(${IDENT})\\.(${IDENT})\\b`, "g"))) {
        const file = await this.moduleFile(m[1] as string, def.file, lang, allFiles);
        const found = file === null ? null : await this.literalIn(file, new RegExp(`^${escape(m[2] as string)}\\s*(?::[^=]+)?=\\s*\\{`));
        if (found !== null) out.push(found);
      }
    // A bare variable: its assignment in the function, else at the top of the file.
    const bare = new RegExp(`^(${IDENT})$`).exec(text);
    if (bare !== null) {
      const name = bare[1] as string;
      const local = assignment(def.lines, 1, def.lines.length, name, lang);
      if (local !== null) return this.shapesOf(local.rhs, def, lang, allFiles, depth + 1);
      const fileLines = (await this.lines(def.file)) ?? [];
      const top = assignment(fileLines, 0, def.start, name, lang);
      if (top !== null) return this.shapesOf(top.rhs, { ...def, lines: fileLines, start: 0 }, lang, allFiles, depth + 1);
      if (lang === "python") {
        const imported = await this.importedFrom(name, def.file, lang, allFiles);
        const found = typeof imported === "string" ? await this.literalIn(imported, new RegExp(`^${escape(name)}\\s*(?::[^=]+)?=\\s*\\{`)) : null;
        if (found !== null) out.push(found);
      }
    }
    return out;
  }

  /** The first object/dict literal opened on a line matching `head` in `file` (JS: the module's export). */
  private async literalIn(file: string, head: RegExp | null): Promise<ShapeAt | null> {
    if (head === null) return null;
    const lines = await this.lines(file);
    if (lines === null) return null;
    const index = lines.findIndex((l) => head.test(l));
    if (index === -1) return null;
    const text = lines.slice(index).join("\n");
    const open = text.indexOf("{", (head.exec(lines[index] as string)?.index ?? 0));
    const inner = open === -1 ? null : balanced(text, open);
    if (inner === null) return null;
    return { shape: parseShape(inner, LANG[extname(file)] as Lang), file, index };
  }

  private async defineIn(file: string, name: string, lang: Lang): Promise<Definition | null> {
    if (!file.startsWith(this.root)) return null;
    const lines = await this.lines(file);
    if (lines === null) return null;
    const fn = functionStart(lines, lines.length - 1, name, lang);
    if (fn === null) return null;
    const head = lines[fn.index] ?? "";
    return {
      name,
      file,
      start: fn.index,
      lines: body(lines, fn.index, lang),
      async: /\basync\b/.test(head.slice(0, head.indexOf(name) + name.length + 20)),
    };
  }
}

/** The function starting at `start`: by indentation (Python) or by braces (JS), capped. */
function body(lines: readonly string[], start: number, lang: Lang, cap = MAX_BODY_LINES): string[] {
  const out = [lines[start] ?? ""];
  if (lang === "python") {
    const indent = /^\s*/.exec(out[0] as string)?.[0].length ?? 0;
    for (let i = start + 1; i < lines.length && out.length < cap; i++) {
      const line = lines[i] ?? "";
      if (line.trim() !== "" && (/^\s*/.exec(line)?.[0].length ?? 0) <= indent) break;
      out.push(line);
    }
    while (out.length > 1 && (out[out.length - 1] as string).trim() === "") out.pop();
    return out;
  }
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length && out.length <= cap; i++) {
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
