import { basename, dirname, extname, relative, sep } from "node:path";
import { balanced, c, Files, numbered, splitTopLevel, type TraceCode, type TraceFrame, type TraceResult } from "./trace.js";

/**
 * Value trace for Java, driven by the JDK's helpful NullPointerException
 * messages (JEP 358): `Cannot invoke "Customer.tier()" because "customer" is
 * null` names what was null, as a local, a `<localN>` slot (classes compiled
 * without -g), a field, or the return value of a method. From there the trace
 * follows the value back through assignments and caller arguments, like the
 * Python and JavaScript trace, and checks for causes it can name. Static
 * reading only; it says nothing where the code is unclear.
 */

const NPE =
  /^(?:[\w$.]+: )?Cannot (?:invoke "([^"]+)"|read field "([\w$]+)"|assign field "([\w$]+)"|load from \w+ array|store to \w+ array|read the array length|throw exception|enter synchronized block|exit synchronized block) because (?:the return value of "([^"]+)"|"([^"]+)") is null/;
const ID = "[A-Za-z_$][\\w$]*";
const MODIFIER = /\b(?:public|protected|private|static|final|synchronized|abstract|native|default|strictfp|transient|volatile)\s+/g;
const MAX_METHOD_LINES = 200;
const MAX_CLASS_LINES = 2_000;
const MAX_HOPS = 6;
const MAX_HEADER_LINE = 300;
const MAX_PROPERTY_FILES = 50;
const WIDE = new Set(["long", "double"]);
const BOXED: Readonly<Record<string, string>> = {
  int: "Integer", long: "Long", short: "Short", byte: "Byte", char: "Character", double: "Double", float: "Float", boolean: "Boolean",
};
/** Fields a framework sets from outside: dependency injection, test mocks, Lombok. */
const INJECTED = /@(?:Autowired|Inject|Resource|Value|Mock|MockBean|Spy|InjectMocks|PersistenceContext|Setter|Data|Builder|AllArgsConstructor|RequiredArgsConstructor|ConfigurationProperties)\b/;
/** Calls that normalize a key before it is stored or looked up. */
const NORMALIZE = /\.(?:toLowerCase|toUpperCase|trim|strip|intern)\s*\(|\bnormali[sz]e\w*\s*\(/;

interface Method {
  readonly name: string;
  readonly file: string;
  /** 0-based index of the header line. */
  readonly start: number;
  /** 0-based index of the closing brace. */
  readonly end: number;
  readonly static: boolean;
  readonly returns: string;
  readonly params: readonly Param[];
}

interface Param {
  readonly type: string;
  readonly name: string;
}

interface Local extends Param {
  /** 0-based line index of the declaration. */
  readonly index: number;
}

interface Lookup {
  readonly map: string;
  readonly key: string;
  readonly file: string;
  readonly index: number;
  /** Class lines and the method the lookup is in, for type and write checks. */
  readonly classFile: string;
  readonly method: Method | null;
}

export async function traceJava(
  message: string,
  frames: readonly TraceFrame[],
  root: string,
  allFiles: () => Promise<readonly string[]>,
): Promise<TraceResult | null> {
  const npe = NPE.exec(message);
  const crash = frames[0];
  if (npe === null || crash === undefined) return null;
  const files = new Files(root);
  const lines = await files.lines(crash.file);
  if (lines === null || lines[crash.line - 1] === undefined) return null;
  const at = (file: string, index: number) => c(`${relative(root, file)}:${index + 1}`);
  const hypotheses: string[] = [];
  const steps: string[] = [];
  const code: TraceCode[] = [];
  const show = async (m: Method, role: string) => {
    const body = (await files.lines(m.file))?.slice(m.start, Math.min(m.end + 1, m.start + 25));
    if (body === undefined || code.some((k) => k.heading.includes(`:${m.start + 1} `))) return;
    code.push({ heading: `Code: ${relative(root, m.file)}:${m.start + 1} (${m.name}), ${role}`, language: "java", lines: numbered(body, m.start) });
  };
  const invoked = npe[1] ?? null;
  const returnOf = npe[4] ?? null;
  const culprit = npe[5] ?? null;
  const crashMethod = await methodAt(files, crash.file, crash.line - 1, shortName(crash.function));
  const result = () => (hypotheses.length + steps.length === 0 ? null : { hypotheses, steps, code });

  // The return value of a method: the producer is that call on the crash line.
  if (returnOf !== null) {
    const name = /([\w$]+)\(([^)]*)\)$/.exec(returnOf);
    if (name === null) return null;
    const call = callOn(lines[crash.line - 1] as string, name[1] as string);
    if (call === null) return null;
    steps.push(`The null is the return value of ${c(call.text)} at ${at(crash.file, crash.line - 1)}.`);
    await explainCall(call.text, crash.file, crash.line - 1, crashMethod, arity(name[2] as string));
    return result();
  }
  if (culprit === null) return null;

  // A field: `this.rates`, `Config.instance`, `<local1>.next`.
  const field = new RegExp(`^(.*)\\.(${ID})$`).exec(culprit);
  if (field !== null) {
    const owner = field[1] as string;
    const fieldName = field[2] as string;
    let classFile: string | null = null;
    if (owner === "this") classFile = crash.file;
    else if (crashMethod !== null) {
      const local = owner.startsWith("<local") ? null : await typeOf(files, owner, crashMethod, crash.line - 1);
      const type = local ?? owner.slice(owner.lastIndexOf(".") + 1);
      classFile = /^[A-Z]/.test(type) ? await classFor(type, crash.file, allFiles) : null;
    }
    steps.push(`The null is the field ${c(culprit)} at ${at(crash.file, crash.line - 1)}.`);
    if (classFile !== null) await explainField(classFile, fieldName);
    return result();
  }

  // A local variable or parameter, by name or by slot.
  if (crashMethod === null) return null;
  let name = culprit;
  const slot = /^<local(\d+)>$/.exec(culprit);
  if (slot !== null) {
    const resolved = await localForSlot(files, crashMethod, crash.line - 1, Number(slot[1]), invoked);
    if (resolved === null) return null;
    name = resolved;
    steps.push(`${c(culprit)} in the message is the local variable ${c(name)} (slot ${slot[1]}; the class was compiled without \`-g\`, so the JVM only knows the slot).`);
  }
  steps.push(`The null is ${c(name)} at ${at(crash.file, crash.line - 1)}.`);

  // Follow it back: assignments in the method, then the caller's argument for a parameter.
  let method: Method = crashMethod;
  let index = crash.line - 1;
  for (let hop = 0, f = 0; hop < MAX_HOPS; hop++) {
    const assigned = await assignmentBefore(files, method, index, name);
    if (assigned !== null) {
      steps.push(`${c(name)} is assigned ${c(assigned.expr)} at ${at(method.file, assigned.index)}.`);
      if (/^\s*null\s*$/.test(assigned.expr)) {
        hypotheses.push(`**Assigned null.** ${c(name)} is set to \`null\` at ${at(method.file, assigned.index)} and not reassigned before ${at(crash.file, crash.line - 1)}.`);
        return result();
      }
      const simple = new RegExp(`^(${ID})$`).exec(assigned.expr);
      if (simple !== null && simple[1] !== "this") {
        // A bare name that is not a local or parameter here is a field.
        if (!(await isLocal(method, simple[1] as string, assigned.index))) {
          await explainField(method.file, simple[1] as string);
          return result();
        }
        name = simple[1] as string;
        index = assigned.index;
        continue;
      }
      const thisField = new RegExp(`^(?:this\\.)?(${ID})$`).exec(assigned.expr);
      if (thisField !== null) await explainField(method.file, thisField[1] as string);
      else await explainCall(assigned.expr, method.file, assigned.index, method, null);
      return result();
    }
    const param = method.params.findIndex((p) => p.name === name);
    const caller = frames[f + 1];
    if (param === -1 || caller === undefined) return result();
    const callerLines = await files.lines(caller.file);
    const args = callerLines === null ? null : callArgs(callerLines[caller.line - 1] ?? "", method.name);
    const arg = args?.[param];
    const callerMethod = await methodAt(files, caller.file, caller.line - 1, shortName(caller.function));
    if (arg === undefined || callerMethod === null) return result();
    steps.push(`${c(name)} is a parameter of ${c(method.name)}, passed as ${c(arg)} at ${at(caller.file, caller.line - 1)}.`);
    f++;
    method = callerMethod;
    index = caller.line - 1;
    const simple = new RegExp(`^(?:this\\.)?(${ID})$`).exec(arg);
    if (simple === null) {
      await explainCall(arg, caller.file, caller.line - 1, callerMethod, null);
      return result();
    }
    if (arg.startsWith("this.") || !(await isLocal(callerMethod, simple[1] as string, caller.line - 1))) {
      await explainField(caller.file, simple[1] as string);
      return result();
    }
    name = simple[1] as string;
  }
  return result();

  async function isLocal(m: Method, n: string, line: number): Promise<boolean> {
    return m.params.some((p) => p.name === n) || (await localsAt(files, m, line + 1)).some((l) => l.name === n);
  }

  /** A call that produced null: look inside the method it calls, or at the lookup itself. */
  async function explainCall(expr: string, file: string, index: number, inMethod: Method | null, argCount: number | null): Promise<void> {
    const call = new RegExp(`^(?:(this|${ID}(?:\\.${ID})*)\\s*\\.\\s*)?(${ID})\\s*\\(`).exec(expr.trim());
    if (call === null) return;
    const receiver = (call[1] ?? "this").replace(/^this\.(?=.)/, "");
    const callee = call[2] as string;
    const args = callArgs(expr, callee) ?? [];
    // `map.get(key)` itself.
    if (callee === "get" || callee === "getProperty") {
      const lookup: Lookup = { map: receiver, key: args[0] ?? "", file, index, classFile: file, method: inMethod };
      if (args.length === 1 && (await explainLookup(lookup, callee))) return;
    }
    // A method of this project: find it and read its return statements.
    const type = receiver === "this" ? null : inMethod === null ? null : await typeOf(files, receiver, inMethod, index);
    const classFile =
      receiver === "this"
        ? file
        : type !== null
          ? await classFor(type, file, allFiles)
          : /^[A-Z]/.test(receiver)
            ? await classFor(receiver, file, allFiles)
            : null;
    if (classFile === null) return;
    const def = await methodNamed(files, classFile, callee, argCount ?? args.length);
    if (def === null) return;
    await show(def, "where the null came from");
    const body = (await files.lines(def.file)) ?? [];
    for (let i = def.start; i <= def.end; i++) {
      // `return x;` on its own line or after the header of a one-line method.
      const ret = /(?:^\s*|[{;]\s*)return\s+(.+?);\s*(?:\}\s*)*(?:\/\/.*)?$/.exec(body[i] ?? "");
      if (ret === null) continue;
      const value = (ret[1] as string).trim();
      if (value === "null") {
        steps.push(`${c(`${def.name}(...)`)} returns \`null\` at ${at(def.file, i)}.`);
        hypotheses.push(
          `**The method returns null on purpose.** ${c(def.name)} returns \`null\` at ${at(def.file, i)}, and ${at(file, index)} uses the result without checking it. Find out which case reached that return before guarding the crash site.`,
        );
        return;
      }
      const inner = new RegExp(`^(${ID}(?:\\.${ID})*)\\s*\\.\\s*(get|getProperty)\\s*\\(`).exec(value);
      if (inner === null) continue;
      const innerArgs = callArgs(value, inner[2] as string) ?? [];
      if (innerArgs.length !== 1) continue;
      steps.push(`${c(`${def.name}(...)`)} returns ${c(value)} at ${at(def.file, i)}.`);
      // The key is a parameter: take the caller's argument for it.
      const keyParam = def.params.findIndex((p) => p.name === innerArgs[0]);
      const lookup: Lookup = {
        map: inner[1] as string,
        key: innerArgs[0] as string,
        file: def.file,
        index: i,
        classFile: def.file,
        method: def,
      };
      await explainLookup(lookup, inner[2] as string, keyParam === -1 ? null : { arg: args[keyParam] ?? null, param: def.params[keyParam] as Param, file, index });
      return;
    }
  }

  /**
   * `map.get(key)` found nothing. Names the cause when it can see it: a key
   * type that never equals the map's (an `int` looked up in a `Map<Long, ...>`),
   * a key normalized where entries are stored but not where they are read, or a
   * properties key the file spells differently. Otherwise says the lookup missed.
   */
  async function explainLookup(
    lookup: Lookup,
    how: string,
    passed: { arg: string | null; param: Param; file: string; index: number } | null = null,
  ): Promise<boolean> {
    const classLines = (await files.lines(lookup.classFile)) ?? [];
    const mapName = lookup.map.replace(/^this\./, "");
    const mapType = await declaredType(files, lookup.classFile, mapName, lookup.method, lookup.index);
    const keyType = passed?.param.type ?? (lookup.method === null ? null : await typeOf(files, lookup.key, lookup.method, lookup.index));
    const at2 = at(lookup.file, lookup.index);

    if (how === "getProperty") {
      const literal = /^"([^"\\]+)"$/.exec(passed?.arg ?? lookup.key)?.[1];
      if (literal === undefined) return false;
      const props = await propertyFiles(classLines);
      if (props.length === 0) return false;
      const keys = props.flatMap((p) => p.keys.map((k) => ({ ...k, file: p.file })));
      if (keys.some((k) => k.key === literal)) return false;
      // Key names only, never values: a properties file can hold secrets.
      const near = keys.filter((k) => similarKey(k.key, literal)).slice(0, 3);
      const where = passed === null ? at2 : at(passed.file, passed.index);
      const fileList = [...new Set(props.map((p) => c(relative(root, p.file))))].join(", ");
      hypotheses.push(
        near.length > 0
          ? `**Property key not in the file.** ${where} reads ${c(literal)}, but ${fileList} has no such key; it has ${near.map((k) => `${c(k.key)} (${at(k.file, k.index)})`).join(", ")}. \`getProperty\` returns \`null\` for a missing key: fix the name on one side rather than defaulting it.`
          : `**Property key not in the file.** ${where} reads ${c(literal)}, which ${fileList} does not set, so \`getProperty\` returns \`null\`. Add the key or fix its name before defaulting it.`,
      );
      return true;
    }

    const generics = mapType === null ? null : /^(?:[\w.]*\.)?(?:Map|HashMap|LinkedHashMap|TreeMap|ConcurrentHashMap|SortedMap|NavigableMap)\s*<([\s\S]+)>$/.exec(mapType.replace(/\s+/g, " "));
    if (generics === null) return false;
    const [mapKey] = splitTopLevel(generics[1] as string, true).map((t) => t.trim());
    if (mapKey === undefined) return false;
    steps.push(`${c(lookup.map)} is a ${c(mapType as string)}; ${c(`${lookup.map}.get(${lookup.key})`)} at ${at2} returns \`null\` when no entry matches.`);

    // An int key in a Map<Long, ...> is boxed to Integer and never equals a Long.
    const keyBase = keyType?.replace(/^final\s+/, "").trim() ?? null;
    const boxedKey = keyBase === null ? null : BOXED[keyBase] ?? keyBase;
    const numeric = new Set(["Integer", "Long", "Short", "Byte", "Double", "Float", "Character"]);
    if (boxedKey !== null && numeric.has(boxedKey) && numeric.has(mapKey) && boxedKey !== mapKey) {
      hypotheses.push(
        `**Map key type differs.** ${c(lookup.map)} is a ${c(mapType as string)}, but ${c(lookup.key)} at ${at2} is ${/^[aeiouAEIOU]/.test(keyBase as string) ? "an" : "a"} ${c(keyBase as string)}${keyBase === boxedKey ? "" : `, boxed to ${c(boxedKey)}`}. \`Map.get\` takes any \`Object\`, and an ${c(boxedKey)} never equals a ${c(mapKey)}, so this lookup always returns \`null\`. Use a ${c(mapKey === "Long" ? "long" : mapKey)} key.`,
      );
      return true;
    }

    // Stored under a normalized key, looked up with the raw one.
    const put = new RegExp(`\\b(?:this\\.)?${escape(mapName)}\\s*\\.\\s*(?:put|putIfAbsent|computeIfAbsent)\\s*\\(`);
    for (let i = 0; i < Math.min(classLines.length, MAX_CLASS_LINES); i++) {
      const line = classLines[i] as string;
      const m = put.exec(line);
      if (m === null) continue;
      const stored = splitTopLevel(balanced(line, m.index + m[0].length - 1) ?? "")[0]?.trim();
      const transform = stored === undefined ? null : NORMALIZE.exec(stored);
      if (stored === undefined || transform === null || NORMALIZE.test(lookup.key)) continue;
      const fn = transform[0].replace(/^\./, "").replace(/\s*\($/, "");
      // The value handed in from the caller may already be normalized there.
      if (passed?.arg != null && NORMALIZE.test(passed.arg)) continue;
      hypotheses.push(
        `**Key normalized on write, not on read.** ${at(lookup.classFile, i)} stores entries under ${c(stored)}, but ${c(`${lookup.map}.get(${lookup.key})`)} at ${at2} looks up the key as given, without ${c(`${fn}()`)}. A key that differs only in ${/Case/.test(fn) ? "case" : "spacing or form"} finds nothing. Apply the same ${c(fn)} on lookup.`,
      );
      return true;
    }

    hypotheses.push(
      `**The lookup found nothing.** ${c(`${lookup.map}.get(${lookup.key})`)} at ${at2} returns \`null\` when no entry matches. Check the key it was given against the stored keys before guarding the crash site.`,
    );
    return true;
  }

  /** A null field: never assigned, assigned to itself, or set only outside the constructor. */
  async function explainField(classFile: string, fieldName: string): Promise<void> {
    const classLines = ((await files.lines(classFile)) ?? []).slice(0, MAX_CLASS_LINES);
    const decl = fieldDeclaration(classLines, fieldName);
    if (decl === null) return;
    steps.push(`${c(fieldName)} is declared at ${at(classFile, decl.index)}: ${c((classLines[decl.index] as string).trim())}`);
    const annotated = INJECTED.test(classLines.slice(Math.max(0, decl.index - 3), decl.index + 1).join("\n")) || INJECTED.test(classLines.slice(0, decl.classStart + 1).join("\n"));
    const self = new RegExp(`^\\s*${escape(fieldName)}\\s*=\\s*${escape(fieldName)}\\s*;`);
    const write = new RegExp(`(?:\\bthis\\s*\\.\\s*|(?<![\\w$.])(?:${ID}\\s*\\.\\s*)?)${escape(fieldName)}\\s*=(?!=)`);
    const writes: number[] = [];
    let selfAt = -1;
    for (let i = 0; i < classLines.length; i++) {
      if (i === decl.index) continue;
      const line = stripCode(classLines[i] as string);
      if (self.test(line)) selfAt = i;
      else if (write.test(line) && !new RegExp(`^\\s*(?:final\\s+)?[\\w<>\\[\\], ?.]+\\s+${escape(fieldName)}\\s*=`).test(line)) writes.push(i);
    }
    if (selfAt !== -1 && writes.length === 0) {
      hypotheses.push(
        `**The field is assigned to itself.** ${at(classFile, selfAt)} reads ${c((classLines[selfAt] as string).trim())}: the parameter ${c(fieldName)} hides the field, so this assigns the parameter to itself and the field stays \`null\`. Write ${c(`this.${fieldName} = ${fieldName};`)}.`,
      );
      return;
    }
    if (annotated || decl.initialized || !decl.private) return;
    if (writes.length === 0) {
      hypotheses.push(
        `**The field is never assigned.** ${c(fieldName)} is declared at ${at(classFile, decl.index)} with no initializer, and nothing in ${c(basename(classFile))} assigns it, so it is always \`null\`. Set it in the constructor.`,
      );
      return;
    }
    const nullWrite = writes.find((i) => new RegExp(`${escape(fieldName)}\\s*=\\s*null\\s*;`).test(classLines[i] as string));
    if (nullWrite !== undefined) steps.push(`${c(fieldName)} is set to \`null\` at ${at(classFile, nullWrite)}.`);
  }

  /** `.properties` files this class loads by name, else all of them under the root. */
  async function propertyFiles(classLines: readonly string[]): Promise<{ file: string; keys: { key: string; index: number }[] }[]> {
    const all = (await allFiles()).filter((f) => extname(f) === ".properties").slice(0, MAX_PROPERTY_FILES);
    const named = new Set<string>();
    for (const line of classLines.slice(0, MAX_CLASS_LINES))
      for (const m of line.matchAll(/"([^"\s]*\.properties)"/g)) named.add(basename(m[1] as string));
    // Only a class that names a properties file it loads; otherwise the key may come from anywhere.
    if (named.size === 0) return [];
    const chosen = all.filter((f) => named.has(basename(f)));
    const out: { file: string; keys: { key: string; index: number }[] }[] = [];
    for (const file of chosen) {
      const props = await files.lines(file);
      if (props === null) continue;
      const keys: { key: string; index: number }[] = [];
      props.forEach((line, index) => {
        const m = /^\s*([^#!\s=:][^=:\s]*)\s*[=:\s]/.exec(line);
        if (m !== null) keys.push({ key: m[1] as string, index });
      });
      out.push({ file, keys });
    }
    return out;
  }
}

/** Same words in another order or case (`region.default` / `default.region`), or one edit apart. */
function similarKey(a: string, b: string): boolean {
  const words = (s: string) => s.toLowerCase().split(/[._-]+/).filter(Boolean).sort().join(".");
  if (words(a) === words(b)) return true;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.replace(/[._-]/g, "") === y.replace(/[._-]/g, "")) return true;
  return Math.abs(x.length - y.length) <= 1 && editDistance(x, y) <= 1;
}

function editDistance(a: string, b: string): number {
  if (a.length > 200 || b.length > 200) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length] as number;
}

/** `com.acme.App.main` → `main`; constructors (`<init>`) → the class name. */
function shortName(fn: string): string {
  const parts = fn.split(".");
  const last = parts[parts.length - 1] as string;
  return last === "<init>" ? ((parts[parts.length - 2] ?? "").split("$").pop() as string) : last;
}

function arity(types: string): number {
  return types.trim() === "" ? 0 : splitTopLevel(types, true).length;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The line without string and char literals or a trailing `//` comment, for brace counting and matching. */
function stripCode(line: string): string {
  return line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])+'/g, "''").replace(/\/\/.*$/, "");
}

function callArgs(text: string, name: string): string[] | null {
  const m = new RegExp(`(?:^|[^\\w$])${escape(name)}\\s*\\(`).exec(text);
  if (m === null) return null;
  const inner = balanced(text, m.index + m[0].length - 1);
  return inner === null ? null : splitTopLevel(inner).map((a) => a.trim());
}

/** The call `recv.name(...)` (or `name(...)`) on a line, with its receiver chain. */
function callOn(line: string, name: string): { text: string } | null {
  const m = new RegExp(`((?:this|${ID})(?:\\s*\\.\\s*${ID})*\\s*\\.\\s*)?(?<![\\w$])${escape(name)}\\s*\\(`).exec(line);
  if (m === null) return null;
  const inner = balanced(line, m.index + m[0].length - 1);
  return inner === null ? null : { text: line.slice(m.index, m.index + m[0].length) + inner + ")" };
}

const HEADER = new RegExp(
  `^\\s*(?:@${ID}(?:\\([^)]*\\))?\\s+)*((?:(?:public|protected|private|static|final|synchronized|abstract|native|default|strictfp)\\s+)*)(?:<[^>]*>\\s+)?([\\w$.<>\\[\\], ?]+?\\s+)?(${ID})\\s*\\(`,
);
const NOT_A_METHOD = /^(?:return|new|throw|else|if|for|while|switch|catch|synchronized|do|try|case)$/;

/** A method or constructor header at line `i`, with its parameters and body extent. */
async function methodHeaderAt(files: Files, file: string, i: number, name: string | null): Promise<Method | null> {
  const lines = await files.lines(file);
  const line = lines?.[i];
  if (lines === null || line === undefined) return null;
  // Method headers are short; skipping long lines also bounds the regex work.
  if (line.length > MAX_HEADER_LINE) return null;
  const m = HEADER.exec(stripCode(line));
  if (m === null) return null;
  const found = m[3] as string;
  const returns = (m[2] ?? "").trim();
  if ((name !== null && found !== name) || NOT_A_METHOD.test(found) || NOT_A_METHOD.test(returns) || (returns === "" && !/^[A-Z]/.test(found))) return null;
  // Parameters may span lines; the body opens with `{` after the closing paren.
  const head = lines.slice(i, i + 8).map(stripCode).join("\n");
  const open = head.indexOf("(", head.indexOf(found));
  const inner = balanced(head, open);
  if (inner === null) return null;
  const after = head.slice(open + inner.length + 2);
  if (!/^\s*(?:throws\s+[\w$.,\s<>]+)?\{/.test(after)) return null;
  const params: Param[] = [];
  for (const raw of splitTopLevel(inner, true)) {
    const p = raw.replace(/@[\w$.]+(?:\([^)]*\))?\s*/g, "").replace(/\bfinal\s+/, "").trim();
    const pm = new RegExp(`^([\\s\\S]+?)\\s+(${ID})$`).exec(p);
    if (pm === null) return null;
    params.push({ type: (pm[1] as string).replace(/\s+/g, " ").replace("...", "[]"), name: pm[2] as string });
  }
  // Body extent by brace counting from the header.
  let depth = 0;
  let opened = false;
  let end = -1;
  for (let j = i; j < Math.min(lines.length, i + MAX_METHOD_LINES); j++) {
    for (const ch of stripCode(lines[j] as string)) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) {
      end = j;
      break;
    }
  }
  if (end === -1) return null;
  return { name: found, file, start: i, end, static: /\bstatic\b/.test(m[1] ?? ""), returns, params };
}

/** The method enclosing line `index`, named `name` (the frame's method). */
async function methodAt(files: Files, file: string, index: number, name: string): Promise<Method | null> {
  if (name.includes("$") || name === "<clinit>") return null; // lambdas, synthetic and static initializers
  for (let i = index; i >= Math.max(0, index - MAX_METHOD_LINES); i--) {
    const m = await methodHeaderAt(files, file, i, name);
    // A same-named method that ends above the line (in an anonymous class, say) is not it.
    if (m !== null && m.end >= index) return m;
  }
  return null;
}

async function methodNamed(files: Files, file: string, name: string, count: number): Promise<Method | null> {
  const lines = (await files.lines(file)) ?? [];
  const found: Method[] = [];
  for (let i = 0; i < Math.min(lines.length, MAX_CLASS_LINES); i++) {
    if (!(lines[i] as string).includes(name)) continue;
    const m = await methodHeaderAt(files, file, i, name);
    if (m !== null && m.params.length === count) found.push(m);
  }
  return found.length === 1 ? (found[0] as Method) : null;
}

/**
 * Locals in scope at line `index`, in declaration order, with the slot each
 * occupies: javac numbers `this`, then the parameters, then locals as they are
 * declared, reusing a block's slots once it closes. `long` and `double` take two.
 */
async function localsAt(files: Files, method: Method, index: number): Promise<Local[]> {
  const lines = (await files.lines(method.file)) ?? [];
  const scopes: Local[][] = [[]];
  const elsewhere: boolean[] = [false];
  const decl = new RegExp(`(?:^\\s*|[;({|]\\s*)(?:final\\s+)?((?:${ID})(?:\\s*\\.\\s*${ID})*(?:\\s*<[^;=()]*>)?(?:\\s*\\[\\s*\\])*)\\s+(${ID})\\s*(?=[=;:,)])`, "g");
  let started = false;
  // Locals declared before the crash line only; those on it are not live yet.
  for (let i = method.start; i < index && i <= method.end; i++) {
    let line = stripCode(lines[i] as string);
    if (!started) {
      const brace = line.indexOf("{", line.indexOf(")"));
      if (brace === -1) continue;
      started = true;
      line = line.slice(brace + 1);
    }
    const found = new Map<number, Local>();
    for (const m of line.matchAll(decl)) {
      const type = (m[1] as string).replace(/\s+/g, "");
      if (NOT_A_METHOD.test(type) || /^(?:throw|new|else|case|instanceof|yield)$/.test(type)) continue;
      const end = (m.index ?? 0) + m[0].length;
      found.set(end - 1, { type, name: m[2] as string, index: i });
      // `String a = "a", b = null;` declares `b` too, in the next slot.
      for (const more of moreDeclarators(line, end)) found.set(more.at, { type, name: more.name, index: i });
    }
    // Walk the line: a declaration joins the innermost open block, except one in a
    // `for (`, `catch (` or `try (` header, which belongs to the block that header opens.
    // Lambda bodies, anonymous and local classes are compiled to other methods: their
    // locals take no slot here.
    let header: Local[] = [];
    for (let k = 0; k < line.length; k++) {
      const local = found.get(k);
      if (local !== undefined && !elsewhere.includes(true)) {
        if (/\b(?:for|catch|try)\s*\([^)]*$/.test(line.slice(0, k))) header.push(local);
        else (scopes[scopes.length - 1] as Local[]).push(local);
      }
      if (line[k] === "{") {
        const before = line.slice(0, k);
        scopes.push(header);
        elsewhere.push(/->\s*$|\bnew\s+[\w$.]+\s*(?:<[^>]*>\s*)?\(.*\)\s*$|\b(?:class|interface|enum|record)\s+[\w$]+[^{]*$/.test(before));
        header = [];
      } else if (line[k] === "}" && scopes.length > 1) {
        scopes.pop();
        elsewhere.pop();
      }
    }
  }
  return scopes.flat();
}

/** Further declarators after the first: `, b = null` and `, c;` up to the statement's `;`. */
function moreDeclarators(line: string, from: number): { name: string; at: number }[] {
  const out: { name: string; at: number }[] = [];
  let depth = 0;
  for (let k = from; k < line.length; k++) {
    const ch = line[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth < 0) break;
    } else if (ch === ";" && depth === 0) break;
    else if (ch === "," && depth === 0) {
      const m = new RegExp(`^\\s*(${ID})\\s*(?:=(?!=)|[,;]|$)`).exec(line.slice(k + 1));
      if (m !== null) out.push({ name: m[1] as string, at: k + m[0].indexOf(m[1] as string) + (m[1] as string).length });
    }
  }
  return out;
}

/** The local or parameter in slot `n` at line `index`, checked against the type the message names. */
async function localForSlot(files: Files, method: Method, index: number, n: number, invoked: string | null): Promise<string | null> {
  const ordered: Param[] = [...(method.static ? [] : [{ type: "this", name: "this" }]), ...method.params, ...(await localsAt(files, method, index))];
  let slot = 0;
  let found: Param | null = null;
  for (const v of ordered) {
    if (slot === n) {
      found = v;
      break;
    }
    slot += WIDE.has(v.type) ? 2 : 1;
  }
  // `Cannot invoke "com.acme.Customer.tier()"`: the variable must be a Customer (or `var`).
  const owner = invoked === null ? null : /([\w$]+)\.[\w$]+\([^)]*\)$/.exec(invoked)?.[1] ?? null;
  const fits = (v: Param) => owner === null || v.type === "var" || v.type.replace(/<.*$/, "").split(".").pop() === owner;
  if (found !== null && found.name !== "this" && fits(found)) return found.name;
  // The slot count can be off (scopes we misread); fall back to the one variable of that type.
  if (owner === null) return null;
  const typed = ordered.filter((v) => v.name !== "this" && v.type !== "var" && fits(v));
  return typed.length === 1 ? (typed[0] as Param).name : null;
}

/** The last assignment to `name` before line `index` in the method, as `name = expr;` or a declaration. */
async function assignmentBefore(files: Files, method: Method, index: number, name: string): Promise<{ expr: string; index: number } | null> {
  const lines = (await files.lines(method.file)) ?? [];
  const pattern = new RegExp(`(?:^|[;{(]|\\s)(?<![\\w$.])${escape(name)}\\s*=(?!=)\\s*([\\s\\S]*)$`);
  for (let i = index - 1; i > method.start; i--) {
    const line = stripCode(lines[i] as string);
    const m = pattern.exec(line);
    if (m === null) continue;
    // The expression runs to the `;`, possibly over a few lines.
    let expr = m[1] as string;
    for (let j = i + 1; !expr.includes(";") && j < Math.min(i + 6, index); j++) expr += ` ${stripCode(lines[j] as string).trim()}`;
    const semi = topLevelSemicolon(expr);
    if (semi === -1) return null;
    return { expr: expr.slice(0, semi).trim(), index: i };
  }
  return null;
}

function topLevelSemicolon(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) return i;
  }
  return -1;
}

/** The declared type of a local, parameter or field of the method's class. */
async function typeOf(files: Files, name: string, method: Method, index: number): Promise<string | null> {
  if (!new RegExp(`^${ID}$`).test(name)) return null;
  const param = method.params.find((p) => p.name === name);
  if (param !== undefined) return param.type;
  const local = (await localsAt(files, method, index)).reverse().find((l) => l.name === name);
  if (local !== undefined) return local.type === "var" ? null : local.type;
  return declaredType(files, method.file, name, null, index);
}

async function declaredType(files: Files, file: string, name: string, method: Method | null, index: number): Promise<string | null> {
  if (method !== null) {
    const t = await typeOf(files, name, method, index);
    if (t !== null) return t;
  }
  const decl = fieldDeclaration(((await files.lines(file)) ?? []).slice(0, MAX_CLASS_LINES), name);
  return decl?.type ?? null;
}

/** A field declaration at class level (one brace deep), skipping locals inside methods. */
function fieldDeclaration(lines: readonly string[], name: string): { index: number; type: string; initialized: boolean; private: boolean; classStart: number } | null {
  const pattern = new RegExp(`^\\s*(?:@${ID}(?:\\([^)]*\\))?\\s+)*((?:(?:public|protected|private|static|final|transient|volatile)\\s+)*)([\\w$.]+(?:\\s*<[^;=()]*>)?(?:\\s*\\[\\s*\\])*)\\s+${escape(name)}\\s*(=|;)`);
  let depth = 0;
  let classStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = stripCode(lines[i] as string);
    if (depth === 1) {
      const m = pattern.exec(line);
      if (m !== null && !/\breturn\b/.test(m[2] as string))
        return { index: i, type: (m[2] as string).replace(/\s+/g, " ").replace(/\s*([<>,])\s*/g, (s) => s.trim() === "," ? ", " : s.trim()), initialized: m[3] === "=" && !/=\s*null\s*;/.test(line), private: /\bprivate\b/.test(m[1] ?? ""), classStart };
    }
    for (const ch of line) {
      if (ch === "{") {
        if (depth === 0) classStart = i;
        depth++;
      } else if (ch === "}") depth--;
    }
  }
  return null;
}

/** The project file for a class by simple name, preferring the same package (directory). */
async function classFor(type: string, near: string, allFiles: () => Promise<readonly string[]>): Promise<string | null> {
  const simple = type.replace(/<[\s\S]*$/, "").split(".").pop();
  if (simple === undefined || !/^[A-Z][\w$]*$/.test(simple)) return null;
  const matches = (await allFiles()).filter((f) => basename(f) === `${simple}.java`);
  const local = matches.filter((f) => dirname(f) === dirname(near));
  if (local.length === 1) return local[0] as string;
  if (matches.length === 1) return matches[0] as string;
  const qualified = type.includes(".") ? matches.filter((f) => f.endsWith(`${sep}${type.replace(/<[\s\S]*$/, "").split(".").join(sep)}.java`)) : [];
  return qualified.length === 1 ? (qualified[0] as string) : null;
}
