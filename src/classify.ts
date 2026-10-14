import type { CrashSignal } from "./rea.js";
import { hex } from "./symbolize.js";

export type CrashKind =
  | "null-pointer-dereference"
  | "stack-overflow"
  | "invalid-memory-access"
  | "execute-non-executable"
  | "permission-violation"
  | "general-protection-fault"
  | "abort"
  | "divide-by-zero"
  | "arithmetic-error"
  | "illegal-instruction"
  | "bus-error"
  | "trap"
  | "fatal-signal";

export interface Classification {
  readonly kind: CrashKind;
  /** Short title fragment, e.g. "NULL pointer dereference". */
  readonly title: string;
  readonly signalName: string;
  readonly explanation: string;
  readonly nextSteps: readonly string[];
  /** How directly the classification follows from recorded facts. */
  readonly confidence: "high" | "medium" | "low";
}

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  7: "SIGBUS",
  8: "SIGFPE",
  11: "SIGSEGV",
};

const NULL_PAGE_LIMIT = 0x10000n;
const STACK_GUARD_REACH = 0x10000n;
const SI_KERNEL = 0x80;

export interface ClassifyInput {
  readonly signal: CrashSignal | null;
  readonly pc: bigint | null;
  readonly sp: bigint | null;
}

export function classify({ signal, pc, sp }: ClassifyInput): Classification {
  if (signal === null)
    return {
      kind: "fatal-signal",
      title: "Crash with no recorded signal",
      signalName: "unknown",
      explanation:
        "The core has no recorded signal information, so the crash type is unknown.",
      nextSteps: [
        "Check how the core was produced (gcore snapshots have no crash signal).",
      ],
      confidence: "low",
    };
  const signalName = SIGNAL_NAMES[signal.number] ?? `signal ${signal.number}`;
  switch (signal.number) {
    case 11:
      return classifySegv(signal, signalName, pc, sp);
    case 6:
      return {
        kind: "abort",
        title: "abort() called",
        signalName,
        explanation:
          "The process aborted itself. Common causes: a failed assert(), an explicit abort(), an uncaught C++ exception, or glibc detecting heap corruption (e.g. double free).",
        nextSteps: [
          "Look at the backtrace above `abort` for assert, __cxa_throw or malloc frames.",
          "If malloc/free frames appear, rerun the reproducer under AddressSanitizer.",
        ],
        confidence: "medium",
      };
    case 8:
      return signal.code === 1
        ? {
            kind: "divide-by-zero",
            title: "Integer divide by zero",
            signalName,
            explanation: "An integer division or modulo used a zero divisor.",
            nextSteps: [
              "Check the divisor at the faulting instruction for a zero guard.",
            ],
            confidence: "high",
          }
        : {
            kind: "arithmetic-error",
            title: "Arithmetic exception",
            signalName,
            explanation: `SIGFPE with code ${signal.code} (overflow or floating-point trap).`,
            nextSteps: ["Inspect the operands of the faulting instruction."],
            confidence: "medium",
          };
    case 4:
      return {
        kind: "illegal-instruction",
        title: "Illegal instruction",
        signalName,
        explanation:
          "The CPU hit an invalid instruction. Often deliberate (`ud2` from __builtin_trap, UBSan trap mode, Rust/Go aborts) or a corrupted program counter.",
        nextSteps: [
          "If the instruction is `ud2`, look for a compiler-inserted trap (unreachable code, failed check).",
          "If the PC is outside any function, suspect a corrupted return address or function pointer.",
        ],
        confidence: "medium",
      };
    case 7:
      return {
        kind: "bus-error",
        title: "Bus error",
        signalName,
        explanation:
          "Usually an access to a memory-mapped file beyond its current end, or a misaligned access on strict hardware.",
        nextSteps: [
          "Check for files truncated while mapped (mmap) by this or another process.",
        ],
        confidence: "medium",
      };
    case 5:
      return {
        kind: "trap",
        title: "Trace/breakpoint trap",
        signalName,
        explanation:
          "A breakpoint instruction (int3) executed outside a debugger.",
        nextSteps: [
          "Look for leftover debug breakpoints or __builtin_debugtrap calls.",
        ],
        confidence: "medium",
      };
    default:
      return {
        kind: "fatal-signal",
        title: `Fatal ${signalName}`,
        signalName,
        explanation: `The process terminated on ${signalName} (code ${signal.code}).`,
        nextSteps: [
          "Check which component sends this signal (watchdog, OOM killer, kill).",
        ],
        confidence: "low",
      };
  }
}

function classifySegv(
  signal: CrashSignal,
  signalName: string,
  pc: bigint | null,
  sp: bigint | null,
): Classification {
  const address = signal.faultAddress;
  if (signal.code === SI_KERNEL)
    return {
      kind: "general-protection-fault",
      title: "General protection fault",
      signalName,
      explanation:
        "The kernel reported no fault address. On x86-64 this usually means a non-canonical pointer: garbage, uninitialized or freed memory used as a pointer.",
      nextSteps: [
        "Inspect the registers used by the faulting instruction for garbage values.",
        "Rerun the reproducer under AddressSanitizer or Valgrind to catch the bad write earlier.",
      ],
      confidence: "medium",
    };
  if (address !== null && signal.code === 1 && address < NULL_PAGE_LIMIT)
    return {
      kind: "null-pointer-dereference",
      title:
        address === 0n
          ? "NULL pointer dereference"
          : `NULL pointer dereference (offset ${hex(address)})`,
      signalName,
      explanation:
        address === 0n
          ? "The program read or wrote through a NULL pointer."
          : `The program accessed ${hex(address)}, which is a small offset from NULL: most likely a field or element accessed through a NULL pointer.`,
      nextSteps: [
        "Find where the pointer used by the faulting instruction is assigned and why it can be NULL.",
        "Add a NULL check or make the invariant explicit (assert) at the producer.",
      ],
      confidence: "high",
    };
  if (address !== null && sp !== null && nearStack(address, sp))
    return {
      kind: "stack-overflow",
      title: "Stack overflow",
      signalName,
      explanation: `The fault address ${hex(address)} is just below the stack pointer, typical of unbounded recursion or a very large stack allocation.`,
      nextSteps: [
        "Look for a repeating pattern in the backtrace (recursion).",
        "Check for large local arrays or alloca() with untrusted sizes.",
      ],
      confidence: "medium",
    };
  if (signal.code === 2 && address !== null && pc !== null && address === pc)
    return {
      kind: "execute-non-executable",
      title: "Jump to non-executable memory",
      signalName,
      explanation:
        "The program counter points into memory that is not executable: usually a corrupted function pointer or return address.",
      nextSteps: [
        "Check the caller frame and any function pointers or vtables involved.",
        "Rerun under AddressSanitizer to catch the memory corruption at its source.",
      ],
      confidence: "medium",
    };
  if (signal.code === 2)
    return {
      kind: "permission-violation",
      title: "Write to read-only memory",
      signalName,
      explanation: `The program accessed ${address === null ? "an address" : hex(address)} without permission, most often writing to read-only data such as a string literal.`,
      nextSteps: [
        "Check whether the destination is a const buffer or string literal.",
      ],
      confidence: "medium",
    };
  return {
    kind: "invalid-memory-access",
    title: "Invalid memory access",
    signalName,
    explanation: `The program accessed unmapped address ${address === null ? "(unknown)" : hex(address)}: a dangling, uninitialized or out-of-bounds pointer.`,
    nextSteps: [
      "Check where the pointer in the faulting instruction came from (freed object, wrong index).",
      "Rerun the reproducer under AddressSanitizer for the allocation and free history.",
    ],
    confidence: "medium",
  };
}

function nearStack(address: bigint, sp: bigint): boolean {
  return address <= sp + 0x1000n && sp - address <= STACK_GUARD_REACH;
}

/**
 * Sharpen an abort using frame names gdb resolved. Frames only refine the
 * signal-based classification; they never override a different signal.
 */
export function refineWithFrames(
  base: Classification,
  frameFunctions: readonly string[],
): Classification {
  if (base.kind !== "abort") return base;
  const has = (pattern: RegExp) =>
    frameFunctions.some((name) => pattern.test(name));
  if (has(/__assert_fail|__assert_rtn/))
    return {
      ...base,
      title: "Assertion failure",
      explanation: "An assert() failed and aborted the process.",
      nextSteps: [
        "Open the first frame in your code below __assert_fail: that line holds the failed condition.",
        "Decide whether the input that broke the invariant should be rejected earlier or handled.",
      ],
      confidence: "high",
    };
  if (has(/__cxa_throw|std::terminate|__gxx_personality|_Unwind_Resume/))
    return {
      ...base,
      title: "Uncaught C++ exception",
      explanation:
        "A C++ exception propagated without a handler and std::terminate aborted the process.",
      nextSteps: [
        "Find the throw site in the backtrace and add a handler or prevent the throw.",
      ],
      confidence: "high",
    };
  if (has(/malloc_printerr|__libc_message|_int_free|_int_malloc/))
    return {
      ...base,
      title: "Heap corruption detected",
      explanation:
        "glibc's allocator found corrupted heap metadata (double free, invalid free or a heap buffer overflow) and aborted.",
      nextSteps: [
        "Rerun the reproducer under AddressSanitizer to find the original bad write or free.",
        "Check the frame that called free/malloc for ownership mistakes.",
      ],
      confidence: "high",
    };
  return base;
}
