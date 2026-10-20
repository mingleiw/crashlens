import type { Issue, IssueSection } from "./issue.js";
import { nativeHypotheses } from "./nativeHints.js";
import { formatLocation, hex } from "./symbolize.js";
import type { TriageFrame, TriageReport } from "./triage.js";

/** Express a core-dump triage report as a crashlens Issue. */
export function toCoreIssue(report: TriageReport): Issue {
  const { classification, crash } = report;
  const where = report.firstOwnFrame ?? report.frames[0] ?? null;
  const whereName = where === null ? null : frameName(where);
  const sections: IssueSection[] = [];
  const hypotheses = nativeHypotheses(report);
  if (hypotheses.length > 0)
    sections.push({ heading: "Hypotheses to check first", kind: "list", items: hypotheses });
  if (report.frames.length > 0)
    sections.push({
      heading: "Backtrace",
      kind: "code",
      language: "",
      lines: report.frames.map(frameLine),
    });
  const showsFunction = report.focus?.reason === "fault" && (report.disassembly?.length ?? 0) > 0;
  if (report.instructions.length > 0 && !showsFunction)
    sections.push({
      heading: "Instructions at the fault",
      kind: "code",
      language: "asm",
      lines: report.instructions.map(
        (insn) => `${insn.isFault ? "=> " : "   "}${insn.text}`,
      ),
    });
  if (report.focus !== null && report.disassembly !== null && report.disassembly.length > 0) {
    const f = report.focus;
    const origin = f.fromUnwindTables ? " (no symbol; boundaries from .eh_frame)" : "";
    sections.push({
      heading: f.reason === "fault" ? `Function around the fault: \`${f.name}\`` : `Call site in your binary: \`${f.name}\``,
      kind: "code",
      language: "asm",
      lines: [
        `; ${f.name} @ ${hex(f.start)}-${hex(f.end)}${origin}, link-time addresses, objdump`,
        ...report.disassembly.map((line) => `${line.marked ? "=> " : "   "}${hex(line.address)}: ${line.text}`),
      ],
    });
  }
  for (const fn of report.decompiled)
    sections.push({
      heading: `Decompiled ${fn.role === "caller" ? "caller " : ""}\`${fn.name}\` (REA + ${fn.provider ?? "decompiler"}: decompiler output, not your source)`,
      kind: "code",
      language: "c",
      lines: fn.pseudocode.split("\n"),
    });
  if (report.relevantRegisters.length > 0)
    sections.push({
      heading: "Registers used by the faulting instruction",
      kind: "list",
      items: report.relevantRegisters.map(
        (entry) =>
          `\`${entry.name}\` = \`${hex(entry.value)}\`${entry.value === 0n ? " ← NULL" : ""}`,
      ),
    });

  return {
    source: "core",
    kind: classification.kind,
    title: classification.title,
    where: whereName,
    summary: summary(report, whereName ?? "unknown location"),
    facts: [
      {
        label: "Program",
        value: `\`${report.program}\`${crash.historicalPid === null ? "" : ` (pid ${crash.historicalPid} at crash time)`}`,
      },
      {
        label: "Signal",
        value: `${classification.signalName}${crash.signal === null ? "" : ` (code ${crash.signal.code})`}`,
      },
      {
        label: "Fault address",
        value:
          crash.signal?.faultAddress == null
            ? "not recorded"
            : `\`${hex(crash.signal.faultAddress)}\``,
      },
      {
        label: "Program counter",
        value: report.pc === null ? "not recorded" : `\`${hex(report.pc)}\``,
      },
      {
        label: "Location",
        value:
          report.faultLocation === null
            ? "unknown"
            : `\`${formatLocation(report.faultLocation)}\``,
      },
      ...(where?.source == null
        ? []
        : [{ label: "Source", value: `\`${where.source}\`` }]),
      ...(report.buildId.status === "unknown"
        ? []
        : [
            {
              label: "Build ID",
              value:
                report.buildId.status === "match"
                  ? `matches the core (\`${report.buildId.binary?.slice(0, 12)}…\`)`
                  : `**mismatch**: binary \`${report.buildId.binary?.slice(0, 12)}…\`, core \`${report.buildId.core?.slice(0, 12)}…\``,
            },
          ]),
    ],
    sections,
    locations: report.frames.flatMap((frame) => {
      const match = frame.source === null ? null : /^(.+):(\d+)$/.exec(frame.source);
      if (match === null) return [];
      const own = frame.location.kind === "binary-function" || frame.location.kind === "binary";
      return [{ file: match[1] as string, line: Number(match[2]), function: frameName(frame), own }];
    }).sort((a, b) => Number(b.own) - Number(a.own)),
    cause: classification.explanation,
    nextSteps:
      hypotheses.length > 0
        ? ["Check the hypotheses at the top of this report before changing the crashing function.", ...classification.nextSteps]
        : classification.nextSteps,
    confidence: classification.confidence,
    warnings: report.warnings,
    evidence: [
      `Core: \`${report.corePath}\` (sha256 \`${crash.coreSha256}\`)`,
      `Binary: \`${report.binaryPath}\` (sha256 \`${report.layout.binarySha256}\`, ${report.layout.imageType})`,
      `REA evidence: crash \`${crash.evidenceId}\`, layout \`${report.layout.evidenceId}\`${report.decompiled.map((fn) => `, decompilation of ${fn.name} \`${fn.evidenceId}\``).join("")}`,
      `gdb: ${report.gdb.status}${report.gdb.reason === undefined ? "" : ` (${report.gdb.reason})`}`,
      ...(report.layout.mitigations === null
        ? []
        : [
            `Build hardening (static, inferred): ${mitigations(report.layout.mitigations)}`,
          ]),
    ],
    limitations: report.limitations,
    signature: report.signature,
    footer:
      "Generated by crashlens from a recorded core; the program was not executed.",
  };
}

function summary(report: TriageReport, whereName: string): string {
  const { classification } = report;
  const inLibrary =
    report.firstOwnFrame !== null && report.frames[0] !== undefined
      ? ` The crash happened inside \`${frameName(report.frames[0])}\`, called from \`${whereName}\` in your binary.`
      : "";
  return `\`${report.program}\` crashed with **${classification.signalName}**: ${classification.title.toLowerCase()} at \`${whereName}\`.${inLibrary} ${classification.explanation}`;
}

function frameName(frame: TriageFrame): string {
  const location = frame.location;
  if (location.kind === "binary-function")
    return `${location.symbol.name}+${hex(location.symbolOffset)}`;
  if (frame.gdbFunction !== null) return frame.gdbFunction;
  return formatLocation(location);
}

function frameLine(frame: TriageFrame): string {
  const address =
    frame.address === null ? "".padEnd(18) : hex(frame.address).padEnd(18);
  const source = frame.source === null ? "" : `  at ${frame.source}`;
  const module =
    "module" in frame.location ? `  [${frame.location.module}]` : "";
  return `#${frame.index} ${address} ${frameName(frame)}${module}${source}`;
}

function mitigations(values: Readonly<Record<string, unknown>>): string {
  const flag = (key: string, label: string) =>
    typeof values[key] === "boolean"
      ? `${label} ${values[key] ? "✓" : "✗"}`
      : null;
  return [
    flag("position_independent", "PIE"),
    flag("nx_indicator", "NX"),
    flag("stack_canary_indicator", "canary"),
    typeof values["relro"] === "string" ? `RELRO ${values["relro"]}` : null,
  ]
    .filter((item) => item !== null)
    .join(", ");
}

/** Core facts that only matter to tools, kept beside the Issue in JSON output. */
export function coreDetails(report: TriageReport): unknown {
  return {
    corePath: report.corePath,
    binaryPath: report.binaryPath,
    pc: report.pc,
    faultLocation: report.faultLocation,
    frames: report.frames,
    registers: report.crash.registers,
    signal: report.crash.signal,
    gdb: report.gdb,
    buildId: report.buildId,
    focus: report.focus,
    disassembly: report.disassembly,
    decompiled: report.decompiled,
  };
}
