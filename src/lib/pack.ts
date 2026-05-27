import type {
  Decisions,
  Overview,
  PackFile,
  Relevance,
  ReviewSignals,
  Runtime,
} from "../types";
import { AHA_LOCAL_CLI_FALLBACK } from "../prompts.js";

export const DEFAULT_RUNTIME: Runtime = {
  ahaCli: AHA_LOCAL_CLI_FALLBACK,
};

type RelevanceCarrier = { relevance: Relevance } | null | undefined;

export function isNoiseSignal(signal: RelevanceCarrier): boolean {
  return !!signal && signal.relevance === "noise";
}

export function isContextSignal(signal: RelevanceCarrier): boolean {
  return !!signal && signal.relevance === "context";
}

export function basename(p: string): string { return p.split("/").slice(-1)[0]; }

export function dirname(p: string | undefined): string {
  const parts = String(p || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function normalizeFileSearch(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export function fileMatchesSearch(file: PackFile, query: string): boolean {
  if (!query) return true;
  const pathText = String(file?.path || "").toLowerCase();
  const baseText = basename(pathText);
  return pathText.includes(query) || baseText.includes(query);
}

export function hasOverviewContent(overview: Overview | null | undefined): boolean {
  return !!(
    overview?.mentalModelDelta ||
    overview?.systemMap ||
    overview?.modelDeltas?.length ||
    overview?.flows?.length ||
    overview?.assumptions?.length ||
    overview?.hotspots?.length
  );
}

export function hasReviewSignals(reviewSignals: ReviewSignals | undefined): boolean {
  return !!(
    reviewSignals &&
    Object.keys(reviewSignals.files || {}).length > 0 &&
    ((reviewSignals.summary?.noiseFiles || 0) > 0 || (reviewSignals.summary?.noiseLines || 0) > 0)
  );
}

export function fileReviewKey(file: PackFile): string {
  return file?.path || file?.id;
}

export function fileSignalKey(file: PackFile): string {
  return file?.path || file?.id;
}

export function categoryLabel(category: string | undefined, categories: Decisions["categories"] = []) {
  const match = categories.find((item) => item?.key === category);
  return match?.label || category;
}
