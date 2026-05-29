import type {
  DecisionCardData,
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

// The reviewable content of an item as plain text — the comparable shape behind
// a baseline. decide: title + claim + check · inspect: title + why + check ·
// verify: text + check.
function focusContent(item: FocusItem): { lens: Lens; title: string; body: string; check: string } {
  if (item.decision) {
    const check = (item.decision.sections || []).find((sec) => sec.kind === "check")?.text || "";
    return { lens: "decide", title: item.decision.title || "", body: item.decision.claim || "", check };
  }
  if (item.hotspot) {
    return { lens: "inspect", title: richTextToPlain(item.hotspot.title), body: richTextToPlain(item.hotspot.why), check: item.hotspot.check || "" };
  }
  if (item.assumption) {
    return { lens: "verify", title: richTextToPlain(item.assumption.text), body: "", check: item.assumption.check || "" };
  }
  return { lens: "decide", title: "", body: "", check: "" };
}

// Snapshot to store when the reviewer triages an item — the "A" baseline.
export function focusItemSnapshot(item: FocusItem, at: string): FocusBaseline {
  return { ...focusContent(item), at };
}

// Did the item's content drift from the baseline the reviewer judged? false when
// there is no baseline (never triaged, or pre-baseline state) — no delta to show.
export function focusBaselineChanged(baseline: FocusBaseline | undefined, item: FocusItem): boolean {
  if (!baseline) return false;
  const now = focusContent(item);
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
  const nonAccepted = resolved.filter((it) => statusMap[it.id] === "flag" || statusMap[it.id] === "block");
  const nonAcceptedContext = nonAccepted
    .map((it) => focusItemContext(it, decisions, files, statusMap))
    .filter(Boolean)
    .join("\n\n———\n\n");
  return { items, open, reReview, resolved, nonAccepted, nonAcceptedContext };
}
