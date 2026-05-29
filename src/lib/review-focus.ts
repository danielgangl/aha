import type {
  DecisionCardData,
  Decisions,
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
  resolved: FocusItem[];
  nonAccepted: FocusItem[];
  nonAcceptedContext: string;
}

// Risk ordering for the burn-down (high floats to the top). Hotspots/assumptions
// have no explicit risk, so they slot at fixed ranks between the risk tiers.
const RISK_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };

// Agent-ready context for a single triaged item (any lens).
export function focusItemContext(item: FocusItem, decisions: Decisions, files: PackFile[], statusMap: StatusMap): string {
  const status = statusMap[item.id];
  if (!status) return "";
  if (item.decision) return buildDecisionAgentContext(item.decision, decisions.categories, files, status);
  if (item.hotspot) return buildHotspotAgentContext(item.hotspot, status);
  if (item.assumption) return buildAssumptionAgentContext(item.assumption, status);
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
): ReviewFocus {
  const items: FocusItem[] = [
    ...(decisions?.cards ?? []).map((d): FocusItem => ({ id: d.id, lens: "decide", rank: RISK_RANK[d.risk ?? ""] ?? 3, decision: d })),
    ...(overview?.hotspots ?? []).map((h): FocusItem => ({ id: h.id, lens: "inspect", rank: 1, hotspot: h })),
    ...(overview?.assumptions ?? []).map((a): FocusItem => ({ id: a.id, lens: "verify", rank: 2, assumption: a })),
  ];
  const open = items.filter((it) => !statusMap[it.id]).sort((a, b) => a.rank - b.rank);
  const resolved = items.filter((it) => statusMap[it.id]).sort((a, b) => a.rank - b.rank);
  const nonAccepted = resolved.filter((it) => statusMap[it.id] === "flag" || statusMap[it.id] === "block");
  const nonAcceptedContext = nonAccepted
    .map((it) => focusItemContext(it, decisions, files, statusMap))
    .filter(Boolean)
    .join("\n\n———\n\n");
  return { items, open, resolved, nonAccepted, nonAcceptedContext };
}
