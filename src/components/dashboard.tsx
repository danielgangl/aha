import React, { useCallback, useEffect, useState } from "react";
import type { PackIndexEntry, Runtime } from "../types";
import { DEFAULT_RUNTIME } from "../lib/pack";
import { EmptyOnboarding } from "./onboarding";

// Compact "N ago" for pack freshness. Browser-only; Date.now() is fine here.
function relativeTime(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

// The dashboard is the home screen once at least one pack exists: a quiet list
// of reviews in flight, each showing how far you got, plus a tucked-away way to
// initialize a new one from a PR. With no packs it falls back to onboarding.
export function Dashboard({
  packIndex,
  runtime = DEFAULT_RUNTIME,
  onOpenPack,
}: {
  packIndex: PackIndexEntry[];
  runtime?: Runtime;
  onOpenPack: (id: string) => void;
}) {
  const [packs, setPacks] = useState(packIndex);

  const deletePack = useCallback(async (id: string) => {
    const res = await fetch("/aha-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `Delete failed (${res.status})`);
    setPacks((prev) => prev.filter((pack) => pack.id !== id));
  }, []);

  if (packs.length === 0) {
    return <EmptyOnboarding runtime={runtime} />;
  }

  return (
    <main className="h-full overflow-y-auto px-6 pt-14 pb-[72px] text-ink bg-[radial-gradient(112%_70%_at_50%_-8%,color-mix(in_oklab,var(--color-blue-soft)_58%,transparent),transparent_62%),var(--color-paper)]">
      <div className="mx-auto w-[min(760px,100%)]">
        <div className="flex items-center gap-[10px] mb-[6px]">
          <span
            aria-hidden="true"
            className="w-9 h-9 grid place-items-center rounded-[12px] bg-surface border border-line-2 text-ink text-[17px] leading-none shadow-[0_1px_0_color-mix(in_oklab,var(--color-surface)_60%,#fff),0_14px_30px_-22px_color-mix(in_oklab,var(--color-blue)_60%,transparent)]"
          >
            ◇
          </span>
          <div className="min-w-0">
            <h1 className="m-0 font-sans font-semibold text-[18px] leading-[1.2] tracking-[-0.014em] text-ink">
              Reviews in flight
            </h1>
            <p className="m-0 text-[12.5px] leading-[1.4] text-ink-3">
              {packs.length} {packs.length === 1 ? "pack" : "packs"} · pick up where you left off
            </p>
          </div>
        </div>

        <NewFromPr onOpenPack={onOpenPack} />

        <ul className="list-none p-0 mt-[18px] grid gap-[10px]">
          {packs.map((pack) => (
            <li key={pack.id}>
              <PackCard pack={pack} onOpen={() => onOpenPack(pack.id)} onDelete={() => deletePack(pack.id)} />
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

function PackCard({ pack, onOpen, onDelete }: { pack: PackIndexEntry; onOpen: () => void; onDelete: () => Promise<void> }) {
  const total = pack.filesChanged || 0;
  const reviewed = Math.min(pack.reviewed || 0, total);
  const pct = total > 0 ? (reviewed / total) * 100 : 0;
  const complete = total > 0 && reviewed >= total;

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const confirmDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    setBusy(true);
    setError("");
    onDelete().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      setConfirming(false);
    });
  };

  return (
    <div
      className="relative group/card"
      onMouseLeave={() => { if (!busy) { setConfirming(false); setError(""); } }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left grid gap-[9px] px-[15px] py-[13px] rounded-[12px] border border-line-2 bg-surface cursor-pointer shadow-[inset_0_1px_0_color-mix(in_oklab,#fff_45%,transparent)] transition-[border-color,box-shadow,transform] duration-200 ease-[ease] hover:border-line-3 hover:-translate-y-px hover:shadow-[0_14px_28px_-22px_color-mix(in_oklab,var(--color-ink)_80%,transparent)] active:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2"
      >
        <div className="flex items-center justify-between gap-[12px]">
          <span className="font-mono text-[11.5px] text-ink-2 truncate">
            {pack.repo} <span className="text-ink-4">#{pack.pr}</span>
          </span>
          <span className="flex-none font-mono text-[10.5px] text-ink-4 [font-variant-numeric:tabular-nums] transition-opacity group-hover/card:opacity-0">
            {relativeTime(pack.updatedAt)}
          </span>
        </div>

        <div className="font-sans text-[14px] font-medium leading-[1.35] tracking-[-0.004em] text-ink truncate">
          {pack.title}
        </div>

        <div className="flex items-center gap-[10px] text-[11px] text-ink-3">
          {(pack.branch || pack.base) && (
            <span className="font-mono text-[10.5px] text-ink-2 bg-bg-3 border border-line rounded-[5px] px-[6px] py-[1px] truncate max-w-[60%]">
              {pack.branch}{pack.base ? ` → ${pack.base}` : ""}
            </span>
          )}
          <span className="font-mono text-ink-4 [font-variant-numeric:tabular-nums]">
            {total} {total === 1 ? "file" : "files"}
          </span>
        </div>

        {total > 0 && (
          <div className="flex items-center gap-[8px]">
            <span className="flex-1 h-1 bg-bg-3 rounded-[2px] overflow-hidden">
              <span
                className={`block h-full rounded-[2px] ${complete ? "bg-pine" : "bg-ink"}`}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="flex-none font-mono text-[10.5px] [font-variant-numeric:tabular-nums] text-ink-3">
              {complete ? "✓ done" : `${reviewed}/${total}`}
            </span>
          </div>
        )}
      </button>

      {/* Delete control — top-right, revealed on hover; two-step confirm. */}
      <div className="absolute top-[10px] right-[12px] flex items-center gap-[6px]" onClick={(event) => event.stopPropagation()}>
        {error ? (
          <span className="font-mono text-[10px] leading-[1.3] text-rose-ink max-w-[200px] truncate" title={error}>
            {error}
          </span>
        ) : confirming ? (
          <>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={busy}
              className="h-[22px] px-[8px] rounded-[6px] border border-[var(--rose-ink)] bg-rose-soft text-[11px] font-medium text-rose-ink cursor-pointer hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setConfirming(false); }}
              disabled={busy}
              className="h-[22px] px-[8px] rounded-[6px] border border-line-2 bg-surface text-[11px] text-ink-3 cursor-pointer hover:text-ink hover:border-line-3 disabled:opacity-60"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label="Delete pack"
            title="Delete pack"
            onClick={(event) => { event.stopPropagation(); setConfirming(true); }}
            className="opacity-0 group-hover/card:opacity-100 focus:opacity-100 transition-opacity h-[22px] px-[8px] rounded-[6px] border border-line-2 bg-surface text-[11px] text-ink-3 cursor-pointer hover:border-[var(--rose-ink)] hover:text-rose-ink focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-1"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// Tucked-away initializer: pick a registered repo + PR number, hit the local
// /aha-generate endpoint, and open the resulting pack. Deterministic only — the
// AI enrichment + update passes come later.
function NewFromPr({ onOpenPack }: { onOpenPack: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [repo, setRepo] = useState("");
  const [pr, setPr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || repos !== null) return;
    let alive = true;
    fetch("/aha-repos.json", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { repos: [] }))
      .then((payload) => {
        if (!alive) return;
        const names = Array.isArray(payload?.repos)
          ? payload.repos.map((entry: { name?: unknown }) => String(entry?.name || "")).filter(Boolean)
          : [];
        setRepos(names);
        setRepo((current) => current || names[0] || "");
      })
      .catch(() => { if (alive) setRepos([]); });
    return () => { alive = false; };
  }, [open, repos]);

  const prValid = /^\d+$/.test(pr.trim());
  const canSubmit = prValid && !busy && (repos?.length ? Boolean(repo) : false);

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    fetch("/aha-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, pr: pr.trim() }),
    })
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || !payload?.ok) throw new Error(payload?.error || `Generate failed (${res.status})`);
        onOpenPack(payload.id);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-[7px] h-[28px] px-[11px] rounded-[8px] border border-line-2 bg-surface text-[12px] text-ink-2 cursor-pointer transition-colors hover:border-line-3 hover:bg-bg-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2"
      >
        <span aria-hidden="true" className="font-mono text-[13px] leading-none text-ink-3">+</span>
        New from PR
      </button>
    );
  }

  return (
    <section className="rounded-[12px] border border-line-2 bg-bg-2 p-[14px] shadow-[inset_0_1px_0_color-mix(in_oklab,#fff_45%,transparent)]">
      <div className="flex items-center justify-between mb-[10px]">
        <span className="text-[12.5px] font-semibold text-ink">Initialize a review from a PR</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="w-6 h-6 grid place-items-center rounded-[5px] border-0 bg-transparent text-ink-3 text-[17px] leading-none cursor-pointer hover:bg-bg-3 hover:text-ink"
        >
          ×
        </button>
      </div>

      {repos !== null && repos.length === 0 ? (
        <div className="text-[12px] leading-[1.5] text-ink-3">
          <p className="m-0 mb-[8px]">
            Register a repo to initialize from here. Add it to{" "}
            <code className="font-mono text-[11px] text-ink-2 bg-bg-3 border border-line rounded-[4px] px-[4px] py-px">.aha.local.json</code>:
          </p>
          <pre className="m-0 font-mono text-[11px] leading-[1.5] text-ink-2 bg-surface border border-line rounded-[8px] p-[10px] overflow-x-auto">{`{
  "repos": [
    { "name": "my-repo", "path": "/absolute/path/to/my-repo" }
  ]
}`}</pre>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-[10px]">
          <label className="grid gap-[4px] min-w-[160px] flex-1">
            <span className="text-[10.5px] font-semibold tracking-[0.04em] uppercase text-ink-3">Repo</span>
            <select
              value={repo}
              disabled={busy || repos === null}
              onChange={(event) => setRepo(event.target.value)}
              className="h-[30px] rounded-[7px] border border-line-2 bg-surface px-[8px] font-mono text-[12px] text-ink outline-none focus:border-blue disabled:opacity-50"
            >
              {repos === null && <option value="">Loading…</option>}
              {repos?.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-[4px] w-[110px]">
            <span className="text-[10.5px] font-semibold tracking-[0.04em] uppercase text-ink-3">PR #</span>
            <input
              value={pr}
              disabled={busy}
              inputMode="numeric"
              placeholder="123"
              onChange={(event) => setPr(event.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              className="h-[30px] rounded-[7px] border border-line-2 bg-surface px-[8px] font-mono text-[12px] text-ink outline-none focus:border-blue placeholder:text-ink-4 disabled:opacity-50"
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="h-[30px] px-[13px] rounded-[7px] border border-ink bg-ink text-bg text-[12px] font-medium cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Generating…" : "Initialize"}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-[10px] mb-0 text-[11.5px] leading-[1.45] text-rose-ink">{error}</p>
      )}
      <p className="mt-[10px] mb-0 font-mono text-[10.5px] leading-[1.4] text-ink-4">
        Builds the deterministic pack via <span className="text-ink-3">gh pr diff</span>. AI enrichment comes later.
      </p>
    </section>
  );
}
