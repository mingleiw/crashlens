// Plain-words labels for the pstack /statechart skill.
export const title = "crashlens serve --ai: Ask AI for a fix (one report, two tabs)";

const n = (v: any) => Object.values(v.asking as Record<string, number>).reduce((a, b) => a + b, 0);

export const state = (v: any) => {
  if (!v.listed) return n(v) > 0 ? "Cleared, an AI request still out" : "Cleared";
  const report = v.ai === 0 ? "No AI suggestion" : v.ai === 1 ? "One AI suggestion" : "Two or more AI suggestions";
  const out = n(v) === 0 ? "" : n(v) === 1 ? ", 1 request out" : ", several requests out";
  return report + out;
};

export const group = (v: any) => (n(v) > 0 ? "waiting" : "idle");
export const colors = { idle: "blue", waiting: "orange" };

export const step = (action: string, from: any, to: any) => {
  switch (action.replace(/\(.*$/, "")) {
    case "Press": return to.calls > from.calls ? "you press Ask AI and confirm" : "you press Ask AI again [turned away]";
    case "Reply": return from.listed ? "Claude answers" : "Claude answers [after Clear all]";
    case "Reload": return "a tab reloads";
    case "Clear": return "you press Clear all";
  }
  return action;
};
