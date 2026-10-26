/**
 * Where the NULL came from in a call through a NULL function pointer. Reads the
 * caller's disassembly (objdump, AT&T syntax) backwards from the indirect call
 * along every path that reaches it, drops paths where a `test r,r` branch
 * proves the register non-NULL, and reports the loads left on the others.
 * Static: a best reading of the machine code, labelled as such in the report.
 */

export interface Instruction {
  readonly address: bigint;
  readonly text: string;
}

/** A memory slot `[base + offset]` named by a load or a NULL check. */
export interface Slot {
  /** Instruction that reads the slot. */
  readonly address: bigint;
  readonly text: string;
  readonly base: string;
  readonly offset: bigint;
}

/** What wrote the call register on one unguarded path. */
export type NullSource =
  | (Slot & {
      readonly kind: "load";
      /** The base register was written between the load and the call, so its crash-time value is not the one used. */
      readonly baseChanged: boolean;
      /** NULL checks that route execution to this load: each slot was NULL when it ran. */
      readonly reachedWhenNull: readonly Slot[];
    })
  | { readonly kind: "zero" | "call-result" | "other"; readonly address: bigint; readonly text: string };

export interface NullCallTrace {
  readonly callAddress: bigint;
  readonly callText: string;
  /** `call *%rax`: the register holding the target. */
  readonly register: string | null;
  /** `call *0x18(%rbx)`: the slot read by the call itself. */
  readonly slot: Slot | null;
  /** Paths into the call where a NULL test proves the register non-NULL. */
  readonly guardedPaths: number;
  readonly sources: readonly NullSource[];
}

const ALIASES: Readonly<Record<string, string>> = {
  eax: "rax", ax: "rax", al: "rax",
  ebx: "rbx", bx: "rbx", bl: "rbx",
  ecx: "rcx", cx: "rcx", cl: "rcx",
  edx: "rdx", dx: "rdx", dl: "rdx",
  esi: "rsi", si: "rsi", sil: "rsi",
  edi: "rdi", di: "rdi", dil: "rdi",
  ebp: "rbp", bp: "rbp", bpl: "rbp",
};
/** Caller-saved registers a call may overwrite (System V x86-64). */
const CLOBBERED_BY_CALL = new Set(["rax", "rcx", "rdx", "rsi", "rdi", "r8", "r9", "r10", "r11"]);
const MAX_STEPS = 5000;
const CHECK_REACH = 4;

function reg(name: string): string {
  const bare = name.replace(/^%/, "");
  return ALIASES[bare] ?? bare.replace(/^(r\d{1,2})[dwb]$/, "$1");
}

function split(text: string): { mnemonic: string; operands: string[] } {
  const space = text.indexOf(" ");
  if (space === -1) return { mnemonic: text, operands: [] };
  // Commas inside "(%rax,%rbx,8)" are not operand separators.
  const operands: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text.slice(space + 1)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      operands.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim() !== "") operands.push(current.trim());
  return { mnemonic: text.slice(0, space).replace(/^(bnd|notrack) /, ""), operands };
}

/** `0x50(%r13)` or `(%r13)` → base and offset; null for indexed, RIP-relative or absolute operands. */
function memoryOperand(operand: string): { base: string; offset: bigint } | null {
  const match = /^(-?0x[0-9a-f]+|-?\d+)?\(%([a-z0-9]+)\)$/.exec(operand);
  if (match === null || match[2] === "rip") return null;
  const raw = match[1] ?? "0";
  const negative = raw.startsWith("-");
  const magnitude = BigInt(negative ? raw.slice(1) : raw);
  return { base: reg(match[2] as string), offset: negative ? -magnitude : magnitude };
}

function jumpTarget(text: string): bigint | null {
  const { mnemonic, operands } = split(text);
  if (!/^j[a-z]+$/.test(mnemonic) || operands.length !== 1) return null;
  const match = /^(?:0x)?([0-9a-f]+)$/.exec(operands[0] as string);
  return match === null ? null : BigInt(`0x${match[1]}`);
}

const isUnconditional = (mnemonic: string) => mnemonic === "jmp" || mnemonic === "ret" || mnemonic === "ud2" || mnemonic === "hlt";

/** The register an instruction writes, as far as this trace needs to know. */
function written(text: string): string | null {
  const { mnemonic, operands } = split(text);
  if (/^(test|cmp|push|j[a-z]+|nop[a-z]*|xchg|ret|endbr64)$/.test(mnemonic) || mnemonic.startsWith("cmp")) return null;
  const last = operands[operands.length - 1];
  return last !== undefined && last.startsWith("%") ? reg(last) : null;
}

/** For a jcc right after `test %r,%r`: the register it tests and whether the taken edge means r == 0. */
function nullTest(lines: readonly Instruction[], index: number): { register: string; takenMeansNull: boolean } | null {
  const jcc = split((lines[index] as Instruction).text).mnemonic;
  const previous = lines[index - 1];
  if (previous === undefined) return null;
  const { mnemonic, operands } = split(previous.text);
  if (mnemonic !== "test" || operands.length !== 2 || operands[0] !== operands[1]) return null;
  const register = reg(operands[0] as string);
  if (jcc === "je" || jcc === "jz") return { register, takenMeansNull: true };
  if (jcc === "jne" || jcc === "jnz") return { register, takenMeansNull: false };
  return null;
}

interface Edge {
  /** Index of the predecessor instruction. */
  readonly from: number;
  readonly taken: boolean;
}

function predecessors(lines: readonly Instruction[], index: number, jumpsTo: ReadonlyMap<bigint, number[]>): Edge[] {
  const edges: Edge[] = [];
  const before = lines[index - 1];
  if (before !== undefined && !isUnconditional(split(before.text).mnemonic)) edges.push({ from: index - 1, taken: false });
  for (const from of jumpsTo.get((lines[index] as Instruction).address) ?? []) edges.push({ from, taken: true });
  return edges;
}

/** A NULL check on an incoming edge, with the slot whose value it tests. */
function checkedSlot(lines: readonly Instruction[], edge: Edge): Slot | null {
  const jump = lines[edge.from];
  if (jump === undefined || jumpTarget(jump.text) === null) return null;
  const test = nullTest(lines, edge.from);
  if (test === null || test.takenMeansNull !== edge.taken) return null;
  for (let i = edge.from - 2; i >= Math.max(0, edge.from - 2 - CHECK_REACH); i--) {
    const line = lines[i] as Instruction;
    if (written(line.text) !== test.register) continue;
    const { mnemonic, operands } = split(line.text);
    const memory = mnemonic === "mov" && operands.length === 2 ? memoryOperand(operands[0] as string) : null;
    return memory === null ? null : { address: line.address, text: line.text, ...memory };
  }
  return null;
}

/** NULL checks that lead into the straight-line run ending at `index`. */
function checksLeadingTo(lines: readonly Instruction[], index: number, jumpsTo: ReadonlyMap<bigint, number[]>): Slot[] {
  const found: Slot[] = [];
  const seen = new Set<number>();
  const visit = (at: number, depth: number) => {
    if (seen.has(at) || depth > 3) return;
    seen.add(at);
    for (const edge of predecessors(lines, at, jumpsTo)) {
      const slot = checkedSlot(lines, edge);
      if (slot !== null) found.push(slot);
      else if (!edge.taken && /^nop/.test(split((lines[edge.from] as Instruction).text).mnemonic)) visit(edge.from, depth + 1);
    }
  };
  visit(index, 0);
  return found;
}

/**
 * Trace the target of the indirect call that returns to `returnAddress`
 * (link-time). `lines` is the whole calling function.
 */
export function traceNullCall(lines: readonly Instruction[], returnAddress: bigint): NullCallTrace | null {
  const callIndex = lines.findIndex((line, i) => line.address < returnAddress && (lines[i + 1]?.address ?? returnAddress) >= returnAddress);
  const call = lines[callIndex];
  if (call === undefined) return null;
  const { mnemonic, operands } = split(call.text);
  if (mnemonic !== "call" || operands.length !== 1 || !(operands[0] as string).startsWith("*")) return null;
  const target = (operands[0] as string).slice(1);
  if (!target.startsWith("%")) {
    const memory = memoryOperand(target);
    return {
      callAddress: call.address,
      callText: call.text,
      register: null,
      slot: memory === null ? null : { address: call.address, text: call.text, ...memory },
      guardedPaths: 0,
      sources: [],
    };
  }

  const jumpsTo = new Map<bigint, number[]>();
  lines.forEach((line, i) => {
    const to = jumpTarget(line.text);
    if (to !== null) jumpsTo.set(to, [...(jumpsTo.get(to) ?? []), i]);
  });

  const register = reg(target);
  const sources = new Map<number, NullSource>();
  // Guarded edges, as "from>to", so a node reached in several states counts once.
  const guarded = new Set<string>();
  let steps = 0;
  // Each state: the instruction about to be examined and the registers written after it on this path.
  const stack: { index: number; changed: ReadonlySet<string> }[] = [];
  const seen = new Set<string>();
  const push = (at: number, changed: ReadonlySet<string>) => {
    for (const edge of predecessors(lines, at, jumpsTo)) {
      const test = jumpTarget((lines[edge.from] as Instruction).text) === null ? null : nullTest(lines, edge.from);
      if (test !== null && test.register === register && !changed.has(register) && test.takenMeansNull !== edge.taken) {
        guarded.add(`${edge.from}>${at}`);
        continue;
      }
      stack.push({ index: edge.from, changed });
    }
  };
  push(callIndex, new Set());
  while (stack.length > 0 && steps++ < MAX_STEPS) {
    const { index, changed } = stack.pop() as { index: number; changed: ReadonlySet<string> };
    const key = `${index}|${[...changed].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = lines[index] as Instruction;
    const parts = split(line.text);
    if (parts.mnemonic === "call" && CLOBBERED_BY_CALL.has(register)) {
      sources.set(index, { kind: register === "rax" ? "call-result" : "other", address: line.address, text: line.text });
      continue;
    }
    const writes = written(line.text);
    if (writes !== register) {
      push(index, writes === null ? changed : new Set([...changed, writes]));
      continue;
    }
    const memory = parts.mnemonic === "mov" && parts.operands.length === 2 ? memoryOperand(parts.operands[0] as string) : null;
    const zero =
      (parts.mnemonic === "xor" && parts.operands[0] === parts.operands[1]) ||
      (parts.mnemonic === "mov" && /^\$0x0$|^\$0$/.test(parts.operands[0] ?? ""));
    sources.set(
      index,
      memory !== null
        ? {
            kind: "load",
            address: line.address,
            text: line.text,
            ...memory,
            baseChanged: changed.has(memory.base),
            reachedWhenNull: checksLeadingTo(lines, index, jumpsTo),
          }
        : { kind: zero ? "zero" : "other", address: line.address, text: line.text },
    );
  }
  return {
    callAddress: call.address,
    callText: call.text,
    register,
    slot: null,
    guardedPaths: guarded.size,
    sources: [...sources.values()].sort((a, b) => (a.address < b.address ? -1 : 1)),
  };
}
