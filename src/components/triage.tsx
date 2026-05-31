import type { TriageStatus } from "../types";

// Shared triage primitives used by both the Decisions mode and the High Level
// Review Focus worklist, so the two render identically from one source.

const STATUS_PILL_BASE =
  "inline-flex items-center h-5 px-2 rounded-[4px] font-mono text-[10px] font-semibold tracking-[0.03em]";

// Read-only triage status pill (✓ Accepted / ? Flagged / ✗ Blocker).
export function StatusPill({ status }: { status: TriageStatus }) {
  const tone =
    status === "accept"
      ? "bg-pine-soft text-pine-ink"
      : status === "flag"
      ? "bg-amber-soft text-amber-ink"
      : "bg-rose-soft text-rose-ink";
  return (
    <span className={`${STATUS_PILL_BASE} ${tone}`}>
      {status === "accept" && "✓ Accepted"}
      {status === "flag" && "? Flagged for discussion"}
      {status === "block" && "✗ Blocker"}
    </span>
  );
}

// The ✓ / ? / ✗ triage toggle group. Clicking the active status clears it.
export function TriageButtons({
  status,
  onSetStatus,
  acceptTitle = "Accept this decision",
}: {
  status: TriageStatus | null | undefined;
  onSetStatus: (status: TriageStatus | null) => void;
  acceptTitle?: string;
}) {
  const base =
    "appearance-none w-[26px] h-[26px] border border-line-2 bg-surface rounded-[6px] text-ink-3 text-[13px] font-semibold cursor-pointer inline-flex items-center justify-center font-mono hover:bg-bg-3 hover:text-ink";
  return (
    <div className="flex gap-1">
      <button
        className={`${base} ${status === "accept" ? "bg-pine! text-white! border-pine!" : ""}`}
        onClick={() => onSetStatus(status === "accept" ? null : "accept")}
        title={acceptTitle}
      >
        ✓
      </button>
      <button
        className={`${base} ${status === "flag" ? "bg-amber! text-ink! border-amber!" : ""}`}
        onClick={() => onSetStatus(status === "flag" ? null : "flag")}
        title="Flag for discussion"
      >
        ?
      </button>
      <button
        className={`${base} ${status === "block" ? "bg-rose! text-white! border-rose!" : ""}`}
        onClick={() => onSetStatus(status === "block" ? null : "block")}
        title="Mark as blocker"
      >
        ✗
      </button>
    </div>
  );
}
