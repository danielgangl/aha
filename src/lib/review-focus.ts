import type {
  DecisionCardData,
  DecisionJump,
  Decisions,
  FocusBaseline,
  Lens,
  Overview,
  OverviewAssumption,
  OverviewHotspot,
  PackFile,
  StatusMap,
} from "../types";
import {
  buildAssumptionAgentContext,
  buildDecisionAgentContext,
  buildHotspotAgentContext,
  richTextToPlain,
} from "./decision-context";

// One Review Focus item — Decisions, Hotspots and Assumptions merged into a
// single typed worklist (decide / inspect / verify).
export interface FocusItem {
  id: string;
  lens: Lens;
  rank: number;
  decision?: DecisionCardData;
  hotspot?: OverviewHotspot;
  assumption?: OverviewAssumption;
}

export interface ReviewFocus {
  items: FocusItem[];
  open: FocusItem[];
  // Triaged, but the content drifted from the baseline you judged — needs re-triage.
  reReview: FocusItem[];
  resolved: FocusItem[];
  nonAccepted: FocusItem[];
  nonAcceptedContext: string;
}

// Risk ordering for the burn-down (high floats to the top). Hotspots/assumptions
// have no explicit risk, so they slot at fixed ranks between the risk tiers.
const RISK_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };

// The merged, unsorted worklist items (decisions + hotspots + assumptions).
export function allFocusItems(decisions: Decisions, overview: Overview | null): FocusItem[] {
  return [
    ...(decisions?.cards ?? []).map((d): FocusItem => ({ id: d.id, lens: "decide", rank: RISK_RANK[d.risk ?? ""] ?? 3, decision: d })),
    ...(overview?.hotspots ?? []).map((h): FocusItem => ({ id: h.id, lens: "inspect", rank: 1, hotspot: h })),
    ...(overview?.assumptions ?? []).map((a): FocusItem => ({ id: a.id, lens: "verify", rank: 2, assumption: a })),
  ];
}

// id -> item, for capturing baselines on triage without re-deriving the list.
export function indexFocusItems(decisions: Decisions, overview: Overview | null): Map<string, FocusItem> {
  return new Map(allFocusItems(decisions, overview).map((item) => [item.id, item] as const));
}

// A stable signature of one item's evidence anchors (path:line:ref:desc).
function evidenceSig(items: DecisionJump[] | undefined): string {
  if (!Array.isArray(items)) return "";
  return items
    .filter(Boolean)
    .map((it) => `${it.path || it.fileId || ""}:${it.line ?? ""}:${it.ref || ""}:${it.desc || ""}`)
    .join("|");
}

// The reviewable content of an item. title/body/check are the displayed gist
// (decide: title+claim+check · inspect: title+why+check · verify: text+check);
// `sig` additionally folds in whyItMatters and the evidence anchors so any
// material drift — not just the headline — is detected as "needs re-review".
function focusContent(item: FocusItem): { lens: Lens; title: string; body: string; check: string; sig: string } {
  let lens: Lens = "decide";
  let title = "";
  let body = "";
  let check = "";
  let why = "";
  let evidence = "";
  if (item.decision) {
    const sections = Array.isArray(item.decision.sections) ? item.decision.sections : [];
    check = sections.find((sec) => sec.kind === "check")?.text || "";
    evidence = evidenceSig(sections.filter((sec) => sec.kind !== "check").flatMap((sec) => sec.items || []));
    lens = "decide";
    title = item.decision.title || "";
    body = item.decision.claim || "";
    why = item.decision.whyItMatters || "";
  } else if (item.hotspot) {
    lens = "inspect";
    title = richTextToPlain(item.hotspot.title);
    body = richTextToPlain(item.hotspot.why);
    check = item.hotspot.check || "";
    evidence = evidenceSig(item.hotspot.evidence);
  } else if (item.assumption) {
    lens = "verify";
    title = richTextToPlain(item.assumption.text);
    check = item.assumption.check || "";
    evidence = evidenceSig(item.assumption.evidence);
  }
  const sig = [lens, title, body, why, check, evidence].join("");
  return { lens, title, body, check, sig };
}

// Snapshot to store when the reviewer triages an item — the "A" baseline.
export function focusItemSnapshot(item: FocusItem, at: string): FocusBaseline {
  return { ...focusContent(item), at };
}

// Did the item's content drift from the baseline the reviewer judged? false when
// there is no baseline (never triaged) — no delta to show. Compares the full
// signature; falls back to the visible fields for baselines captured before sig.
export function focusBaselineChanged(baseline: FocusBaseline | undefined, item: FocusItem): boolean {
  if (!baseline) return false;
  const now = focusContent(item);
  if (typeof baseline.sig === "string" && baseline.sig.length > 0) return baseline.sig !== now.sig;
  return baseline.title !== now.title || baseline.body !== now.body || baseline.check !== now.check;
}

// Agent-ready context for a single triaged item (any lens).
export function focusItemContext(item: FocusItem, decisions: Decisions, files: PackFile[], statusMap: StatusMap): string {
  const status = statusMap[item.id];
  if (!status) return "";
  if (item.decision) return buildDecisionAgentContext(item.decision, decisions.categories, files, status);
  if (item.hotspot) return buildHotspotAgentContext(item.hotspot, status, files);
  if (item.assumption) return buildAssumptionAgentContext(item.assumption, status, files);
  return "";
}

// Build the merged, risk-sorted Review Focus worklist + the bundled context for
// everything triaged-but-not-accepted (flagged / blocked), ready to hand to an
// agent. Pure data — the view just renders it.
export function buildReviewFocus(
  decisions: Decisions,
  overview: Overview | null,
  statusMap: StatusMap,
  files: PackFile[],
  baselines: Record<string, FocusBaseline> = {},
): ReviewFocus {
  const items = allFocusItems(decisions, overview);
  const byRank = (a: FocusItem, b: FocusItem) => a.rank - b.rank;
  const open = items.filter((it) => !statusMap[it.id]).sort(byRank);
  const triaged = items.filter((it) => statusMap[it.id]);
  // Triaged + content changed since the baseline you judged → re-review; else resolved.
  const reReview = triaged.filter((it) => focusBaselineChanged(baselines[it.id], it)).sort(byRank);
  const resolved = triaged.filter((it) => !focusBaselineChanged(baselines[it.id], it)).sort(byRank);
  // Everything still flagged/blocked is unresolved work for an agent — including
  // items that drifted into re-review (they'd otherwise silently fall out).
  const nonAccepted = [...reReview, ...resolved].filter((it) => statusMap[it.id] === "flag" || statusMap[it.id] === "block");
  const nonAcceptedContext = nonAccepted
    .map((it) => focusItemContext(it, decisions, files, statusMap))
    .filter(Boolean)
    .join("\n\n———\n\n");
  return { items, open, reReview, resolved, nonAccepted, nonAcceptedContext };
}
