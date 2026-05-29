import type {
  DecisionCardData,
  DecisionCategory,
  DecisionJump,
  OverviewAssumption,
  OverviewHotspot,
  PackFile,
  RichRef,
  RichText,
  TriageStatus,
} from "../types";
import { plainDiffContent } from "./diff";

function statusLabelFor(status: TriageStatus): string {
  return status === "block" ? "BLOCKER / declined" : status === "flag" ? "FLAGGED for discussion" : "open";
}

function richTextToPlain(value: RichText): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => (typeof part === "string" ? part : part?.label || part?.id || "")).join("");
}

function refsToPlain(refs: RichRef[] | undefined): string {
  if (!Array.isArray(refs)) return "";
  return refs.map((ref) => ref.label || ref.id).filter(Boolean).join(", ");
}

// A small code window (±3 lines) around an evidence anchor, as plain text.
function evidenceCodeText(item: DecisionJump, files: PackFile[]): string {
  const filePath = item.path || item.fileId;
  if (!filePath || item.line == null) return "";
  const file = files.find((f) => f.path === filePath || f.id === filePath);
  if (!file) return "";
  const lines = file.diff.filter((line) => line.k !== "hunk");
  const idx = lines.findIndex((line) => line.L === item.line || line.R === item.line);
  if (idx < 0) return "";
  const start = Math.max(0, idx - 3);
  const end = Math.min(lines.length, idx + 4);
  return lines
    .slice(start, end)
    .map((line) => {
      const sig = line.k === "add" ? "+" : line.k === "del" ? "-" : " ";
      const num = String(line.R ?? line.L ?? "");
      return `    ${sig} ${num.padStart(4)}  ${plainDiffContent(line.c)}`;
    })
    .join("\n");
}

// A decision's full context as agent-ready plain text: status, title,
// risk/category, claim, why-it-matters, the decision question, and every piece
// of evidence with its location + a code window. Handed to an agent on a
// flagged/blocked decision so it can act with everything it needs.
export function buildDecisionAgentContext(
  card: DecisionCardData,
  categories: DecisionCategory[],
  files: PackFile[],
  status: TriageStatus,
): string {
  const statusLabel = statusLabelFor(status);
  const category = categories.find((c) => c.key === card.category)?.label || card.category || "";
  const sections = Array.isArray(card.sections) ? card.sections : [];
  const check = sections.find((sec) => sec.kind === "check");
  const evidence = sections.filter((sec) => sec.kind !== "check" && Array.isArray(sec.items) && sec.items.length > 0);

  const out: string[] = [`Review decision — ${statusLabel}`];
  if (card.title) out.push(card.title);
  const meta = [card.risk ? `risk: ${card.risk}` : "", category ? `category: ${category}` : ""].filter(Boolean).join(" · ");
  if (meta) out.push(meta);
  if (card.claim) out.push("", card.claim);
  if (card.whyItMatters) out.push("", `Why it matters: ${card.whyItMatters}`);
  if (check?.text) out.push("", `Decision to make: ${check.text}`);
  if (evidence.length) {
    out.push("", "Evidence:");
    for (const sec of evidence) {
      for (const it of (sec.items || []).filter(Boolean)) {
        const path = it.path || it.fileId || "";
        const loc = path ? `${path}${it.line != null ? `:${it.line}` : ""}` : "";
        const head = [it.ref, loc].filter(Boolean).join("  ") || "(no location)";
        out.push(`- ${head}${it.desc ? ` — ${it.desc}` : ""}`);
        const code = evidenceCodeText(it, files);
        if (code) out.push(code);
      }
    }
  }
  return out.join("\n").trim();
}

export function buildHotspotAgentContext(hotspot: OverviewHotspot, status: TriageStatus): string {
  const out: string[] = [`Review hotspot (inspect) — ${statusLabelFor(status)}`];
  const title = richTextToPlain(hotspot.title);
  if (title) out.push(title);
  const why = richTextToPlain(hotspot.why);
  if (why) out.push("", why);
  const refs = refsToPlain(hotspot.refs);
  if (refs) out.push("", `Refs: ${refs}`);
  return out.join("\n").trim();
}

export function buildAssumptionAgentContext(assumption: OverviewAssumption, status: TriageStatus): string {
  const out: string[] = [`Review assumption (verify) — ${statusLabelFor(status)}`];
  const text = richTextToPlain(assumption.text);
  if (text) out.push(text);
  const refs = refsToPlain(assumption.refs);
  if (refs) out.push("", `Refs: ${refs}`);
  return out.join("\n").trim();
}
