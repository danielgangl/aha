import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type {
  CanonicalFileId,
  CodeView,
  CodeViewGroup,
  DiffLine,
  FileSignal,
  FocusBaseline,
  NoiseMode,
  Overview,
  PackIndexEntry,
  PackFile,
  Pr,
  PersistedReviewState,
  ReadingOrder,
  RangeAnchor,
  Relevance,
  ReviewSignalPattern,
  ReviewSignals,
  ReviewState,
  RichPart,
  RichRef,
  RichText as RichTextValue,
  Runtime,
  SideAnchor,
  SignalRange,
  SignalScope,
  StatusMap,
  SymbolMap,
  SystemMap,
  TriageStatus,
  ViewedFileEntry,
} from "./types";
import {
  DEFAULT_RUNTIME,
  fileReviewKey,
  fileSignalKey,
  isContextSignal,
  isNoiseSignal,
  dirname,
} from "./lib/pack";
import { plainDiffContent } from "./lib/diff";
import { focusItemSnapshot, indexFocusItems } from "./lib/review-focus";
import { CallSitesPanel } from "./components/call-sites";
import { FileDiffPanel } from "./components/file-panel";
import { FileCard } from "./components/file-card";
import { HighLevelLeftRail, HighLevelView } from "./components/high-level";
import { LeftRail } from "./components/left-rail";
import { Dashboard } from "./components/dashboard";
import { EmptyOnboarding, UpdateModal } from "./components/onboarding";
import { WorkflowModal } from "./components/workflow";
import "./styles/global.css";

// v2/app.jsx — file-based PR reader.
// Single document scroll. Each file: header → tiny "what this file does"
// note → diff with inline AI margin notes. Clicking any symbol opens the
// right-rail call-sites panel.

type Mode = "code" | "high-level";
interface FlashKey { fileId: string; line?: number; t: number; }

// ── App shell ──────────────────────────────────────────────────
function App({
  pr,
  runtime = DEFAULT_RUNTIME,
  initialReviewState,
  initialReviewStateAvailable,
  selectedPackId,
  onHome,
}: {
  pr: Pr;
  runtime?: Runtime;
  initialReviewState: ReviewState | null;
  initialReviewStateAvailable: boolean;
  selectedPackId: string;
  onHome: () => void;
}) {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const initialReadingMode = pr.readingOrders[0]?.key || "default";
  const initialCodeView = useMemo(() => buildCodeView(pr, initialReadingMode), [pr, initialReadingMode]);

  const [activeSymId, setActiveSymId] = useState<string | null>(null);
  const [activeFileId, setActiveFileId] = useState<string | null>(initialCodeView.files[0]?.id || pr.files[0]?.id || null);
  const reviewStateKey = useMemo(() => `aha:${reviewStateScope(pr)}:review-state`, [pr]);
  const legacyReviewStateStorageKey = useMemo(() => `aha:${pr.number || pr.title}:review-state`, [pr.number, pr.title]);
  const legacyStatusStorageKey = useMemo(() => `aha:${pr.number || pr.title}:decision-status`, [pr.number, pr.title]);
  const startingReviewState = useMemo(
    () => initialReviewStateAvailable
      ? normalizeReviewState(initialReviewState, pr)
      : readLocalReviewState(pr, reviewStateKey, legacyReviewStateStorageKey, legacyStatusStorageKey),
    [initialReviewState, initialReviewStateAvailable, legacyReviewStateStorageKey, legacyStatusStorageKey, pr, reviewStateKey]
  );
  const startingCollapsedFiles = useMemo(() => {
    const next = new Set(startingReviewState.viewed);
    for (const file of pr.files) {
      const signal = pr.reviewSignals.files[fileSignalKey(file)];
      if (isNoiseSignal(signal) && signal && signal.hideByDefault !== false) next.add(fileReviewKey(file));
    }
    return next;
  }, [pr.files, pr.reviewSignals.files, startingReviewState.viewed]);
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set(startingReviewState.viewed));
  const [viewedFileMap, setViewedFileMap] = useState<Record<string, ViewedFileEntry>>(() => startingReviewState.viewedFiles);
  const [changedViewedFiles, setChangedViewedFiles] = useState<Set<string>>(() => new Set(startingReviewState.changedViewed));
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => startingCollapsedFiles);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelFileId, setPanelFileId] = useState<string | null>(null);
  const [panelFileLine, setPanelFileLine] = useState<number | null>(null);
  const [leftRailWidth, setLeftRailWidth] = useState(() => readStoredNumber("aha:left-rail-width", defaultLeftRailWidth()));
  const [rightRailWidth, setRightRailWidth] = useState(() => readStoredNumber("aha:right-rail-width", defaultRightRailWidth()));
  // Mode switch: "high-level" (orientation + review decisions) vs "code" (diff reader).
  // Default to High Level so reviewers orient before reading the diff.
  const [mode, setMode] = useState<Mode>("high-level");
  // Triage state per decision card. null = open; "accept" | "flag" | "block".
  const [decisionStatus, setDecisionStatus] = useState<StatusMap>(() => startingReviewState.decisions);
  // Per-item "A" baseline — the content snapshot taken when the reviewer triaged.
  const [baselines, setBaselines] = useState<Record<string, FocusBaseline>>(() => startingReviewState.baselines);
  const focusIndex = useMemo(() => indexFocusItems(pr.decisions, pr.overview), [pr]);
  const [readingMode, setReadingMode] = useState(initialReadingMode);
  // Two independent rail filters, both default off so the list starts as a
  // burn-down of what's left: viewed files hidden (re-check to bring them
  // back, struck through), likely-noise files hidden.
  const [includeViewed, setIncludeViewed] = useState(false);
  const [includeNoise, setIncludeNoise] = useState(false);
  // FileCard still speaks the legacy NoiseMode; "expanded" is now reached only
  // by the per-block inline reveal, not a global control.
  const noiseMode: NoiseMode = includeNoise ? "all" : "focus";
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  // Transient flash highlight when jumping from a decision card to a diff line.
  const [flashKey, setFlashKey] = useState<FlashKey | null>(null);
  const [decisionFlashId, setDecisionFlashId] = useState<string | null>(null);
  const hasHydratedPersistRef = useRef(false);
  const skipNextPersistRef = useRef(false);

  const symbol = activeSymId ? pr.symbols[activeSymId] : null;
  const panelFile = panelFileId ? (pr.files.find((file) => file.id === panelFileId) ?? null) : null;
  const baseCodeView = useMemo(
    () => readingMode === initialReadingMode ? initialCodeView : buildCodeView(pr, readingMode),
    [initialCodeView, initialReadingMode, pr, readingMode]
  );
  const codeView = useMemo(
    () => applyRailFilters(baseCodeView, {
      reviewSignals: pr.reviewSignals,
      includeNoise,
      includeViewed,
      reviewedSet: reviewed,
    }),
    [baseCodeView, includeNoise, includeViewed, reviewed, pr.reviewSignals]
  );

  useEffect(() => {
    if (readingMode !== "default" && !pr.readingOrders.some((order) => order.key === readingMode)) {
      const fallbackReadingMode = pr.readingOrders[0]?.key || "default";
      setReadingMode(fallbackReadingMode);
      setActiveFileId(buildCodeView(pr, fallbackReadingMode).files[0]?.id || pr.files[0]?.id || null);
    }
  }, [pr, pr.readingOrders, readingMode]);

  // Apply theme tweak
  useEffect(() => {
    document.body.classList.toggle("theme-dark", t.theme === "dark");
  }, [t.theme]);

  useEffect(() => {
    if (!hasHydratedPersistRef.current) {
      hasHydratedPersistRef.current = true;
      return;
    }
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    const state: PersistedReviewState = {
      schemaVersion: "0.2",
      viewed: Array.from(reviewed),
      viewedFiles: viewedFileMap,
      decisions: decisionStatus,
      baselines,
      updatedAt: new Date().toISOString(),
    };
    persistReviewState(reviewStateKey, state, selectedPackId);
  }, [decisionStatus, baselines, reviewed, selectedPackId, viewedFileMap, reviewStateKey]);

  const onSymbol = useCallback((id: string) => {
    setActiveSymId(id);
    setPanelFileId(null);
    setPanelOpen(true);
  }, []);

  // High Level file references enrich in place: open the file's diff in the
  // right panel instead of switching to the Code tab — stay in flow, same focus.
  const onOpenFileInPanel = useCallback((fileId: string, line?: number) => {
    const targetFileId = pr._fileAliasById?.[fileId] || fileId;
    setActiveSymId(null);
    setPanelFileId(targetFileId);
    setPanelFileLine(line ?? null);
    setPanelOpen(true);
    // Ensure the panel is wide enough to actually read code.
    setRightRailWidth((width) => {
      const next = clampRailWidth(Math.max(width, 640));
      localStorage.setItem("aha:right-rail-width", String(next));
      return next;
    });
  }, [pr._fileAliasById]);

  const onJumpToFile = useCallback((fileId: string, line?: number) => {
    const targetFileId = pr._fileAliasById?.[fileId] || fileId;
    // If we're in decisions mode, switch back to code first so the file is
    // mounted in the DOM, then scroll on next frame.
    const doScroll = () => {
      const el = document.getElementById(targetFileId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveFileId(targetFileId);
        // Flash the line / file as the reviewer arrives.
        setFlashKey({ fileId: targetFileId, line, t: Date.now() });
        setTimeout(() => setFlashKey((k) => (k && k.t === flashKey?.t ? null : k)), 1800);
      }
    };
    if (mode !== "code") {
      setMode("code");
      requestAnimationFrame(() => requestAnimationFrame(doScroll));
    } else {
      doScroll();
    }
  }, [mode, flashKey, pr._fileAliasById]);

  const onJumpToDecision = useCallback((decisionId: string) => {
    const doScroll = () => {
      const el = document.getElementById(decisionId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setDecisionFlashId(decisionId);
        setTimeout(() => setDecisionFlashId((id) => (id === decisionId ? null : id)), 1800);
      }
    };
    setMode("high-level");
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
  }, []);

  const onJumpToOverviewSection = useCallback((sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const onToggleReviewed = useCallback((file: PackFile) => {
    const key = fileReviewKey(file);
    const shouldScrollToNext = !reviewed.has(key);
    const viewedAt = new Date().toISOString();
    setReviewed(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        setCollapsedFiles((collapsed) => {
          const collapsedNext = new Set(collapsed);
          collapsedNext.add(key);
          return collapsedNext;
        });
      }
      return next;
    });
    setViewedFileMap((prev) => {
      const next = { ...prev };
      if (!shouldScrollToNext) {
        delete next[key];
        return next;
      }
      next[key] = {
        diffFingerprint: file.diffFingerprint || diffFingerprintForFile(file),
        viewedAt,
      };
      return next;
    });
    setChangedViewedFiles((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (shouldScrollToNext) {
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToViewedFileHeader(file, centerRef.current)));
    }
  }, [reviewed]);

  const onToggleCollapsed = useCallback((file: PackFile) => {
    const key = fileReviewKey(file);
    setCollapsedFiles(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setStatus = useCallback((cardId: string, s: TriageStatus | null) => {
    setDecisionStatus((prev) => {
      const next = { ...prev };
      if (s) next[cardId] = s;
      else delete next[cardId];
      return next;
    });
    // Triaging (re)baselines the item to current content; clearing drops it.
    setBaselines((prev) => {
      const next = { ...prev };
      const item = focusIndex.get(cardId);
      if (s && item) next[cardId] = focusItemSnapshot(item, new Date().toISOString());
      else delete next[cardId];
      return next;
    });
  }, [focusIndex]);


  const onRailResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = leftRailWidth;

    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampRailWidth(startWidth + moveEvent.clientX - startX);
      setLeftRailWidth(nextWidth);
      localStorage.setItem("aha:left-rail-width", String(nextWidth));
    };
    const onUp = () => {
      document.body.classList.remove("resizing-rail");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    document.body.classList.add("resizing-rail");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [leftRailWidth]);

  const onRightRailResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightRailWidth;

    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampRailWidth(startWidth + startX - moveEvent.clientX);
      setRightRailWidth(nextWidth);
      localStorage.setItem("aha:right-rail-width", String(nextWidth));
    };
    const onUp = () => {
      document.body.classList.remove("resizing-rail");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    document.body.classList.add("resizing-rail");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [rightRailWidth]);

  // Update active file on scroll based on which file header is closest to top
  const centerRef = useRef<HTMLElement | null>(null);
  const briefingRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (mode !== "code") return;
    const root = centerRef.current;
    const briefing = briefingRef.current;
    if (!root || !briefing) return;
    const update = () => {
      root.style.setProperty("--file-head-sticky-top", "0px");
    };
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(briefing);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [mode, codeView.groups]);

  useEffect(() => {
    if (mode !== "code") return;
    const root = centerRef.current;
    if (!root) return;
    const onScroll = () => {
      const top = root.scrollTop + 150;
      let best = codeView.files[0]?.id || null;
      for (const f of codeView.files) {
        const el = document.getElementById(f.id);
        if (el && el.offsetTop <= top) best = f.id;
      }
      setActiveFileId(best);
    };
    root.addEventListener("scroll", onScroll);
    return () => root.removeEventListener("scroll", onScroll);
  }, [codeView.files, mode]);

  const reviewedCount = reviewed.size;
  const totalFileCount = pr.files.length;
  const hiddenByFilters = totalFileCount - codeView.files.length;
  const noiseFileCount = pr.reviewSignals?.summary?.noiseFiles || 0;
  const repositoryName = pr.repositoryName || pr.repository?.name || "aha";

  if (pr.files.length === 0) {
    return (
      <div className="block h-screen">
        <EmptyOnboarding runtime={runtime} />
      </div>
    );
  }

  return (
    <div className={`grid grid-rows-[46px_1fr] h-screen overflow-hidden density-${t.density}`}>
      {/* TOPBAR */}
      <header className="flex items-center gap-[12px] px-[14px] border-b border-line bg-rail z-10 min-w-0">
        <button
          type="button"
          onClick={onHome}
          title="Back to dashboard"
          className="inline-flex items-center gap-[7px] font-semibold tracking-[-0.012em] text-[13.5px] text-ink bg-transparent border-0 cursor-pointer rounded-[6px] px-[2px] -mx-[2px] hover:text-ink focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2"
        >
          <span aria-hidden="true" className="w-[14px] h-[14px] rounded-[4px] bg-ink relative before:content-[''] before:absolute before:inset-[3px] before:border-[1.5px] before:border-rail before:rounded-[1px]" />
          <span>aha</span>
        </button>
        <div className="inline-flex items-center gap-[6px] text-ink-3 text-[12.5px]">
          <span className="text-ink-2">{repositoryName}</span>
          <span className="text-ink-4">/</span>
          <span className="text-ink font-medium font-mono">#{pr.number}</span>
          <span className="text-ink-4">·</span>
          <span className="text-ink max-w-[380px] max-[1180px]:max-w-[220px] max-[980px]:hidden overflow-hidden text-ellipsis whitespace-nowrap">{pr.title}</span>
        </div>

        <span className="font-mono text-[11.5px] text-ink-2 bg-bg-3 border border-line rounded-[5px] px-[7px] py-[2px] max-[980px]:hidden">{pr.branch} → {pr.base}</span>

        {/* Mode switch — High Level orientation vs Code diff reader */}
        <div className="inline-flex items-center bg-bg-3 border border-line rounded-[8px] p-[2px] gap-0">
          <button
            className="group inline-flex items-center gap-[6px] h-[24px] px-[10px] border-0 bg-transparent rounded-[6px] text-ink-3 text-[12px] font-medium cursor-pointer font-sans data-[active=true]:bg-surface data-[active=true]:text-ink data-[active=true]:shadow-[0_1px_2px_rgba(0,0,0,.06),0_0_0_0.5px_var(--line-2)] not-data-[active=true]:hover:text-ink"
            data-active={mode === "high-level"}
            onClick={() => setMode("high-level")}
            title="Review orientation"
          >
            <span className="font-sans text-[12px] font-semibold text-ink-4 group-data-[active=true]:text-ink">◇</span> High Level
          </button>
          <button
            className="group inline-flex items-center gap-[6px] h-[24px] px-[10px] border-0 bg-transparent rounded-[6px] text-ink-3 text-[12px] font-medium cursor-pointer font-sans data-[active=true]:bg-surface data-[active=true]:text-ink data-[active=true]:shadow-[0_1px_2px_rgba(0,0,0,.06),0_0_0_0.5px_var(--line-2)] not-data-[active=true]:hover:text-ink"
            data-active={mode === "code"}
            onClick={() => setMode("code")}
            title="Read the diff (default)"
          >
            Code
          </button>
        </div>

        <div className="flex-1" />

        <button
          className="h-[24px] px-[10px] border border-line rounded-[5px] bg-bg-3 text-ink-2 text-[11px] font-medium cursor-pointer hover:bg-blue-soft hover:text-blue-ink hover:border-blue-soft"
          type="button"
          onClick={() => setUpdateOpen(true)}
          title="Show the update prompt for your agent"
        >
          Update
        </button>

        <button
          className="h-[24px] px-[8px] border-0 rounded-[5px] bg-bg-3 text-ink-2 font-mono text-[10.5px] cursor-pointer hover:bg-blue-soft hover:text-blue-ink"
          type="button"
          onClick={() => setWorkflowOpen(true)}
          title="Copy aha commands and AI prompts"
        >
          cmd
        </button>

        <div className="inline-flex items-center gap-[8px] text-ink-2 text-[12px]">
          <span className="font-mono max-[1180px]:hidden">{pr.filesChanged} files</span>
          <span className="text-ink-3 font-mono">
            <span style={{ color: "var(--pine-ink)" }}>+{pr.added}</span>{" "}
            <span style={{ color: "var(--rose-ink)" }}>−{pr.removed}</span>
          </span>
        </div>

        <button
          className="inline-flex items-center justify-center w-[26px] h-[26px] border border-line rounded-[6px] bg-bg-3 text-ink-2 text-[13px] leading-none cursor-pointer transition-[background,color,border-color] duration-[0.14s] ease-[ease] hover:bg-blue-soft hover:text-blue-ink hover:border-blue-soft focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2"
          type="button"
          onClick={() => setTweak("theme", t.theme === "dark" ? "light" : "dark")}
          title={t.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-label="Toggle light and dark theme"
          data-theme={t.theme}
        >
          <span aria-hidden="true">{t.theme === "dark" ? "☀" : "☾"}</span>
        </button>

      </header>

      {workflowOpen && <WorkflowModal pr={pr} runtime={runtime} onClose={() => setWorkflowOpen(false)} />}
      {updateOpen && <UpdateModal runtime={runtime} onClose={() => setUpdateOpen(false)} />}

      <div
        className={`relative grid h-full overflow-hidden ${
          panelOpen
            ? "grid-cols-[var(--left-rail-width,300px)_minmax(0,1fr)_var(--right-rail-width,340px)] max-[1180px]:grid-cols-[var(--left-rail-width,260px)_minmax(0,1fr)_var(--right-rail-width,320px)] max-[980px]:grid-cols-[var(--left-rail-width,230px)_minmax(0,1fr)_var(--right-rail-width,320px)]"
            : "grid-cols-[var(--left-rail-width,300px)_minmax(0,1fr)_32px] max-[1180px]:grid-cols-[var(--left-rail-width,260px)_minmax(0,1fr)_32px] max-[980px]:grid-cols-[var(--left-rail-width,230px)_minmax(0,1fr)_32px]"
        }`}
        style={{
          "--left-rail-width": `${leftRailWidth}px`,
          "--right-rail-width": `${rightRailWidth}px`,
        } as React.CSSProperties}
      >
        {mode === "code" ? (
          <LeftRail
            files={codeView.files}
            groups={codeView.groups}
            activeId={activeFileId}
            reviewedSet={reviewed}
            changedViewedSet={changedViewedFiles}
            onJump={onJumpToFile}
            readingOrders={pr.readingOrders}
            readingMode={readingMode}
            onReadingModeChange={setReadingMode}
            reviewSignals={pr.reviewSignals}
            includeViewed={includeViewed}
            onIncludeViewedChange={setIncludeViewed}
            includeNoise={includeNoise}
            onIncludeNoiseChange={setIncludeNoise}
            noiseFileCount={noiseFileCount}
            totalFileCount={totalFileCount}
            reviewedCount={reviewedCount}
            hiddenByFilters={hiddenByFilters}
          />
        ) : mode === "high-level" ? (
          <HighLevelLeftRail
            overview={pr.overview}
            decisions={pr.decisions}
            statusMap={decisionStatus}
            onJump={onJumpToOverviewSection}
          />
        ) : (
          null
        )}

        <div
          className="workspace-rail-resizer"
          role="separator"
          aria-orientation="vertical"
          title="Resize sidebar"
          onPointerDown={onRailResizeStart}
        />

        <div
          className={`workspace-rail-resizer right ${panelOpen ? "" : "hidden"}`}
          role="separator"
          aria-orientation="vertical"
          title="Resize call sites sidebar"
          onPointerDown={onRightRailResizeStart}
        />

        <main className="overflow-y-auto bg-bg scroll-smooth" ref={centerRef}>
          {mode === "high-level" ? (
            <HighLevelView
              overview={pr.overview}
              decisions={pr.decisions}
              files={pr.files}
              symbols={pr.symbols}
              statusMap={decisionStatus}
              baselines={baselines}
              setStatus={setStatus}
              flashId={decisionFlashId}
              onSymbol={onSymbol}
              onFile={onOpenFileInPanel}
              onDecision={onJumpToDecision}
            />
          ) : (
            <>
              {/* Briefing strip — minimal, code-author-voice */}
              <div className="bg-paper border-b border-line py-[14px] px-[24px] flex flex-wrap gap-y-[16px] gap-x-[24px] items-start justify-between" ref={briefingRef}>
                <div className="flex gap-[14px] items-start min-w-0 flex-[1_1_360px]">
                  <div aria-hidden="true" className="w-[30px] h-[30px] rounded-[8px] grid place-items-center bg-surface border border-line-2 text-ink text-[15px] leading-none shrink-0 shadow-[0_1px_0_color-mix(in_oklab,var(--color-surface)_60%,#fff),0_10px_22px_-16px_color-mix(in_oklab,var(--color-blue)_60%,transparent)]">◇</div>
                  <div>
                    <h1 className="font-sans font-semibold text-[16px] leading-[1.3] m-0 mb-[3px] text-ink tracking-[-0.005em]">{pr.title}</h1>
                    <div className="text-[12.5px] text-ink-2 leading-[1.5] max-w-[760px]">{pr.oneLiner}</div>
                  </div>
                </div>
              </div>

              <div className="px-[24px] pt-[18px] pb-[80px] w-full max-w-none m-0 box-border max-[980px]:px-[18px] max-[980px]:pt-[16px] max-[980px]:pb-[80px]">
                {codeView.files.map((f, i) => (
                  <FileCard
                    key={f.id}
                    file={f}
                    order={readingMode === "default" ? null : i + 1}
                    signal={pr.reviewSignals.files[fileSignalKey(f)]}
                    patterns={pr.reviewSignals.patterns}
                    symbols={pr.symbols}
                    noiseMode={noiseMode}
                    onSymbol={onSymbol}
                    activeSym={activeSymId}
                    reviewed={reviewed.has(fileReviewKey(f))}
                    changedSinceViewed={changedViewedFiles.has(fileReviewKey(f))}
                    onToggleReviewed={onToggleReviewed}
                    collapsed={collapsedFiles.has(fileReviewKey(f))}
                    onToggleCollapsed={onToggleCollapsed}
                    scrollRoot={centerRef}
                    onJumpToFile={onJumpToFile}
                    onJumpToSymbol={onSymbol}
                    flash={!!flashKey && flashKey.fileId === f.id}
                  />
                ))}

                <div style={{ marginTop: 28, padding: 18, border: "1px dashed var(--line-2)", borderRadius: 10, textAlign: "center", color: "var(--ink-3)" }}>
                  You've reached the end of {codeView.files.length} files. <strong>{reviewedCount}</strong> marked as reviewed.{" "}
                  <button className="h-[28px] px-[11px] border border-ink rounded-[7px] bg-ink text-bg text-[12px] font-medium cursor-pointer inline-flex items-center gap-[6px] hover:opacity-90" style={{ marginLeft: 12 }}>Submit review</button>
                </div>
              </div>
            </>
          )}
        </main>

        <aside className={`border-l border-line bg-rail overflow-y-auto flex flex-col ${panelOpen ? "" : "w-[36px]"}`}>
          {panelOpen ? (
            panelFileId ? (
              <FileDiffPanel
                file={panelFile}
                line={panelFileLine}
                symbols={pr.symbols}
                onSymbol={onSymbol}
                onClose={() => setPanelOpen(false)}
                onOpenInCode={() => onJumpToFile(panelFileId, panelFileLine ?? undefined)}
              />
            ) : (
              <CallSitesPanel
                symbol={symbol}
                onClose={() => setPanelOpen(false)}
                onJumpToFile={onJumpToFile}
              />
            )
          ) : (
            <button className="w-[36px] border-0 bg-transparent cursor-pointer h-full text-ink-3 font-mono text-[11px] [writing-mode:vertical-rl] [text-orientation:mixed] py-[14px] flex items-center justify-center hover:bg-bg-3 hover:text-ink" onClick={() => setPanelOpen(true)} title="Open context panel">
              Context →
            </button>
          )}
        </aside>
      </div>

    </div>
  );
}

interface Tweaks {
  theme: string;
  showAiNotes: boolean;
  density: string;
}

const TWEAK_DEFAULTS: Tweaks = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "showAiNotes": true,
  "density": "default"
}/*EDITMODE-END*/;

interface ReviewStateResult {
  available: boolean;
  data: unknown;
}

type LoaderState =
  | { status: "loading" }
  | { status: "dashboard"; runtime: Runtime; packIndex: PackIndexEntry[] }
  | { status: "viewer"; pr: Pr; runtime: Runtime; reviewState: ReviewState | null; reviewStateAvailable: boolean; packIndex: PackIndexEntry[]; selectedPackId: string }
  | { status: "error"; error: Error };

function AhaLoader() {
  const [state, setState] = useState<LoaderState>({ status: "loading" });
  const [selectedPackId, setSelectedPackId] = useState(() => selectedPackFromLocation());

  // Single navigation primitive: pack id → viewer, "" → dashboard. Keeps URL
  // (`?pack=…`) and state in lockstep so deep links and back/forward work.
  const navigate = useCallback((packId: string) => {
    setPackLocation(packId);
    setSelectedPackId(packId);
  }, []);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });

    async function load(): Promise<LoaderState> {
      const runtimeRequest = fetch("/aha-runtime.json", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : DEFAULT_RUNTIME))
        .catch(() => DEFAULT_RUNTIME);
      const indexResponse = await fetch(packUrl("/aha-packs.json", selectedPackId), { cache: "no-store" });
      const indexPayload = indexResponse.ok ? await indexResponse.json() : { packs: [] };
      const packIndex = normalizePackIndex(indexPayload?.packs);
      const runtime = normalizeRuntime(await runtimeRequest);

      // No valid explicit pack selected → dashboard (which itself falls back to
      // onboarding when the library is empty). Strip any stale ?pack.
      const requestedPackIsAvailable = selectedPackId && packIndex.some((pack) => pack.id === selectedPackId);
      if (!requestedPackIsAvailable) {
        if (selectedPackFromLocation()) setPackLocation("");
        return { status: "dashboard", runtime, packIndex };
      }

      const packRequest = fetch(packUrl("/aha.json", selectedPackId), { cache: "no-store" })
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to load aha.json (${res.status})`);
          return res.json();
        });
      const stateRequest: Promise<ReviewStateResult> = fetch(packUrl("/aha-state.json", selectedPackId), { cache: "no-store" })
        .then((res) => (res.ok
          ? res.json().then((data: unknown) => ({ available: true, data }))
          : { available: false, data: null }))
        .catch(() => ({ available: false, data: null }));
      const [pack, reviewStateResult] = await Promise.all([packRequest, stateRequest]);
      const pr = normalizeAhaPack(pack);
      return {
        status: "viewer",
        pr,
        runtime,
        reviewState: reviewStateResult.available ? normalizeReviewState(reviewStateResult.data, pr) : null,
        reviewStateAvailable: reviewStateResult.available,
        packIndex,
        selectedPackId,
      };
    }

    load()
      .then((next) => { if (alive) setState(next); })
      .catch((error: unknown) => {
        if (alive) {
          setState({
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [selectedPackId]);

  if (state.status === "loading") {
    return <div className="min-h-screen grid place-content-center gap-[8px] bg-bg text-ink-2">Loading aha.json…</div>;
  }

  if (state.status === "error") {
    return (
      <div className="min-h-screen grid place-content-center gap-[8px] bg-bg text-rose-ink">
        <strong>Could not load aha.json.</strong>
        <span className="text-ink-3">{state.error.message}</span>
      </div>
    );
  }

  if (state.status === "dashboard") {
    return <Dashboard packIndex={state.packIndex} runtime={state.runtime} onOpenPack={navigate} />;
  }

  return (
    <App
      key={state.selectedPackId || `${state.pr.repositoryName}:${state.pr.number}`}
      pr={state.pr}
      runtime={state.runtime}
      initialReviewState={state.reviewState}
      initialReviewStateAvailable={state.reviewStateAvailable}
      selectedPackId={state.selectedPackId}
      onHome={() => navigate("")}
    />
  );
}

function selectedPackFromLocation(): string {
  return new URLSearchParams(window.location.search).get("pack") || "";
}

function setPackLocation(packId: string): void {
  const url = new URL(window.location.href);
  if (packId) url.searchParams.set("pack", packId);
  else url.searchParams.delete("pack");
  window.history.replaceState(null, "", url);
}

function packUrl(pathname: string, packId: string): string {
  if (!packId) return pathname;
  return `${pathname}?pack=${encodeURIComponent(packId)}`;
}

function normalizePackIndex(value: unknown): PackIndexEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      path: typeof entry.path === "string" ? entry.path : "",
      repo: typeof entry.repo === "string" ? entry.repo : "",
      pr: typeof entry.pr === "string" || typeof entry.pr === "number" ? entry.pr : "",
      title: typeof entry.title === "string" ? entry.title : "",
      branch: typeof entry.branch === "string" ? entry.branch : "",
      base: typeof entry.base === "string" ? entry.base : "",
      kind: typeof entry.kind === "string" ? entry.kind : "",
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
      filesChanged: Number.isFinite(Number(entry.filesChanged)) ? Number(entry.filesChanged) : 0,
      reviewed: Number.isFinite(Number(entry.reviewed)) ? Number(entry.reviewed) : 0,
      focusTotal: Number.isFinite(Number(entry.focusTotal)) ? Number(entry.focusTotal) : 0,
      focusDecided: Number.isFinite(Number(entry.focusDecided)) ? Number(entry.focusDecided) : 0,
      focusFlagged: Number.isFinite(Number(entry.focusFlagged)) ? Number(entry.focusFlagged) : 0,
      focusBlocked: Number.isFinite(Number(entry.focusBlocked)) ? Number(entry.focusBlocked) : 0,
    }))
    .filter((entry) => entry.id);
}

function normalizeRuntime(runtime: unknown): Runtime {
  const r = runtime as { ahaCli?: unknown } | null | undefined;
  const ahaCli = typeof r?.ahaCli === "string" && r.ahaCli.trim()
    ? r.ahaCli.trim()
    : DEFAULT_RUNTIME.ahaCli;
  return { ahaCli };
}

function normalizeAhaPack(pack: any): Pr {
  const deduped = dedupeFilesByPath(Array.isArray(pack.files) ? pack.files : []);
  const files = deduped.files.map((file) => ({
    ...file,
    diffFingerprint: typeof file.diffFingerprint === "string" && file.diffFingerprint
      ? file.diffFingerprint
      : diffFingerprintForFile(file),
  }));
  const fileAliasById = deduped.fileAliasById;
  const decisions = pack.decisions || { categories: [], cards: [], questions: [] };
  const canonicalFileId = canonicalFileIdFor(files, fileAliasById);
  const decisionCards = normalizeDecisionCards(decisions.cards, canonicalFileId);
  const readingOrders = normalizeReadingOrders(pack.readingOrders, files, fileAliasById);
  const reviewSignals = normalizeReviewSignals(pack.reviewSignals, files, fileAliasById);
  const normalizedDecisions = {
    categories: Array.isArray(decisions.categories) ? decisions.categories : [],
    cards: decisionCards,
    questions: normalizeDecisionQuestions(decisions.questions, canonicalFileId),
  };
  return {
    ...pack,
    schemaVersion: pack.schemaVersion || "0.1",
    files,
    _fileAliasById: fileAliasById,
    symbols: normalizeSymbols(pack.symbols, canonicalFileId),
    groups: Array.isArray(pack.groups) ? pack.groups : [],
    readingOrders,
    overview: normalizeOverview(pack.overview, canonicalFileId),
    reviewSignals,
    decisions: normalizedDecisions,
    repositoryName: pack.repositoryName || pack.repoName || pack.repository?.name || "",
    author: pack.author || { name: "Unknown", initials: "?" },
    filesChanged: pack.filesChanged ?? files.length,
    added: pack.added ?? files.reduce((sum, file) => sum + (file.add || 0), 0),
    removed: pack.removed ?? files.reduce((sum, file) => sum + (file.del || 0), 0),
  };
}

function normalizeReviewSignals(reviewSignals: any, files: PackFile[], fileAliasById: Record<string, string> = {}): ReviewSignals {
  const fileById = new Map(files.map((file) => [file.id, file]));
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const patterns = normalizeReviewSignalPatterns(reviewSignals?.patterns);
  const inputFiles: Record<string, any> = reviewSignals?.files && typeof reviewSignals.files === "object" ? reviewSignals.files : {};
  const normalizedFiles: Record<string, FileSignal> = {};
  for (const [fileKey, signal] of Object.entries(inputFiles)) {
    const aliasPath = fileAliasById[fileKey];
    const file = fileByPath.get(fileKey) || fileById.get(fileKey) || (aliasPath ? fileByPath.get(aliasPath) : null);
    if (!file || !signal || typeof signal !== "object") continue;
    const canonicalKey = fileSignalKey(file);
    const normalizedSignal: FileSignal = {
      relevance: normalizeSignalRelevance(signal.relevance, "normal"),
      source: ["ai", "deterministic", "manual"].includes(signal.source) ? signal.source : "ai",
      hideByDefault: signal.hideByDefault !== false,
      categories: Array.isArray(signal.categories) ? signal.categories.filter(Boolean) : [],
      reason: typeof signal.reason === "string" ? signal.reason : "",
      ranges: normalizeSignalRanges(signal.ranges, patterns, file.path, fileByPath, fileAliasById),
    };
    mergeNormalizedSignal(normalizedFiles, canonicalKey, normalizedSignal);
    for (const range of normalizedSignal.ranges) {
      if (!isContextSignal(range)) continue;
      for (const path of signalRangePaths(range, file.path)) {
        if (path === canonicalKey || !fileByPath.has(path)) continue;
        mergeNormalizedSignal(normalizedFiles, path, {
          relevance: "normal",
          source: normalizedSignal.source,
          hideByDefault: false,
          categories: [],
          reason: "",
          ranges: [range],
        });
      }
    }
  }
  const noiseFiles = Object.values(normalizedFiles).filter(isNoiseSignal).length;
  const noiseLines = Object.values(normalizedFiles)
    .flatMap((signal) => signal.ranges || [])
    .filter((range) => isNoiseSignal(range) && range.hideByDefault !== false)
    .reduce((sum: number, range) => sum + rangeLineCount(range), 0);
  return {
    version: Number(reviewSignals?.version) || 1,
    patterns,
    summary: {
      noiseFiles,
      noiseLines,
      primaryFiles: Math.max(0, files.length - noiseFiles),
    },
    files: normalizedFiles,
  };
}

type IdentityFileId = (id: string) => string | null;
const identityFileId: IdentityFileId = (id) => id;

function normalizeSymbols(symbols: any, canonicalFileId: IdentityFileId = identityFileId): SymbolMap {
  if (!symbols || typeof symbols !== "object") return {};
  const normalized: SymbolMap = {};
  for (const [id, symbol] of Object.entries<any>(symbols)) {
    if (!symbol || typeof symbol !== "object") continue;
    normalized[id] = {
      ...symbol,
      defined: normalizeSymbolLocation(symbol.defined, canonicalFileId),
      callers: Array.isArray(symbol.callers)
        ? symbol.callers.map((caller: any) => normalizeSymbolLocation(caller, canonicalFileId))
        : [],
      notCallers: Array.isArray(symbol.notCallers)
        ? symbol.notCallers.map((caller: any) => normalizeSymbolLocation(caller, canonicalFileId))
        : [],
    };
  }
  return normalized;
}

function normalizeSymbolLocation(location: any, canonicalFileId: IdentityFileId = identityFileId): any {
  if (!location || typeof location !== "object") return location;
  const rawPath = typeof location.path === "string"
    ? location.path
    : typeof location.fileId === "string"
      ? location.fileId
      : typeof location.file === "string"
        ? location.file
        : "";
  if (!rawPath) return location;
  const path = canonicalFileId(rawPath) || rawPath;
  const next = { ...location, path };
  delete next.fileId;
  delete next.file;
  return next;
}

function mergeNormalizedSignal(target: Record<string, FileSignal>, key: string, signal: FileSignal): void {
  if (!target[key]) {
    target[key] = { ...signal, ranges: [] };
  }
  const existing = target[key];
  existing.ranges ||= [];
  const seen = new Set(existing.ranges.map((range) => range.id));
  for (const range of signal.ranges || []) {
    if (seen.has(range.id)) continue;
    existing.ranges.push(range);
    seen.add(range.id);
  }
}

function signalRangePaths(range: SignalRange, ownerPath: string): Set<string> {
  const paths = new Set<string>();
  for (const side of ["left", "right"] as const) {
    const anchor = range?.anchor?.[side];
    if (anchor) paths.add(anchor.path || ownerPath);
  }
  return paths;
}

function normalizeReviewSignalPatterns(patterns: any): Record<string, ReviewSignalPattern> {
  if (!patterns || typeof patterns !== "object" || Array.isArray(patterns)) return {};
  const normalized: Record<string, ReviewSignalPattern> = {};
  for (const [id, pattern] of Object.entries<any>(patterns)) {
    if (!id || !pattern || typeof pattern !== "object" || Array.isArray(pattern)) continue;
    if (pattern.id != null && pattern.id !== id) continue;
    if (typeof pattern.label !== "string" || !pattern.label.trim()) continue;
    normalized[id] = {
      id,
      label: pattern.label,
      source: ["user", "ai"].includes(pattern.source) ? pattern.source : "ai",
      description: typeof pattern.description === "string" ? pattern.description : "",
    };
  }
  return normalized;
}

function normalizeSignalRanges(
  ranges: any,
  patterns: Record<string, ReviewSignalPattern> = {},
  ownerPath = "",
  fileByPath: Map<string, PackFile> = new Map(),
  fileAliasById: Record<string, string> = {},
): SignalRange[] {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .filter((range: any) => range && typeof range === "object")
    .map((range: any, index: number): SignalRange => {
      const patternId = typeof range.patternId === "string" && patterns[range.patternId] ? range.patternId : undefined;
      return {
        id: range.id || `noise-range-${index + 1}`,
        relevance: normalizeSignalRelevance(range.relevance, "noise"),
        source: ["ai", "deterministic", "manual"].includes(range.source) ? range.source : "ai",
        kind: range.kind || range.categories?.[0] || "likely-noise",
        hideByDefault: range.hideByDefault !== false,
        reason: typeof range.reason === "string" ? range.reason : "",
        scope: normalizeSignalScope(range.scope),
        ...(patternId ? { patternId } : {}),
        anchor: normalizeRangeAnchor(range.anchor, ownerPath, fileByPath, fileAliasById),
      };
    });
}

function normalizeSignalRelevance(value: unknown, fallback: Relevance): Relevance {
  if (value === "noise" || value === "normal" || value === "context") return value;
  if (value === "low") return "normal";
  return fallback;
}

function normalizeSignalScope(scope: any): SignalScope | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  return {
    before: typeof scope.before === "string" ? scope.before : "",
    after: typeof scope.after === "string" ? scope.after : "",
  };
}

function normalizeRangeAnchor(
  anchor: any,
  ownerPath = "",
  fileByPath: Map<string, PackFile> = new Map(),
  fileAliasById: Record<string, string> = {},
): RangeAnchor {
  let left = normalizeSideAnchor(anchor?.left, ownerPath, fileByPath, fileAliasById);
  let right = normalizeSideAnchor(anchor?.right, ownerPath, fileByPath, fileAliasById);
  const isCrossFile = [left, right].some((side) => side?.path && side.path !== ownerPath);
  if (isCrossFile && ownerPath) {
    if (left && !left.path) left = { ...left, path: ownerPath };
    if (right && !right.path) right = { ...right, path: ownerPath };
  }
  return { left, right };
}

function normalizeSideAnchor(
  anchor: any,
  ownerPath = "",
  fileByPath: Map<string, PackFile> = new Map(),
  fileAliasById: Record<string, string> = {},
): SideAnchor | null {
  if (!anchor) return null;
  const start = Number(anchor.start);
  const end = Number(anchor.end ?? anchor.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const rawPath = typeof anchor.path === "string" ? anchor.path : "";
  const aliasPath = fileAliasById[rawPath];
  const path = rawPath && fileByPath.has(rawPath) ? rawPath : aliasPath && fileByPath.has(aliasPath) ? aliasPath : "";
  return path && path !== ownerPath ? { path, start, end } : { start, end };
}

function rangeLineCount(range: SignalRange): number {
  const counts = (["left", "right"] as const).map((side) => {
    const anchor = range.anchor?.[side];
    if (!anchor) return 0;
    return Math.abs(anchor.end - anchor.start) + 1;
  });
  return Math.max(...counts, 0);
}

function normalizeOverview(overview: any, canonicalFileId: IdentityFileId = identityFileId): Overview | null {
  if (!overview || typeof overview !== "object") return null;
  const usedIds = new Set<string>();
  return {
    mentalModelDelta: normalizeRichText(overview.mentalModelDelta, canonicalFileId),
    systemMap: normalizeSystemMap(overview.systemMap, canonicalFileId),
    modelDeltas: Array.isArray(overview.modelDeltas)
      ? overview.modelDeltas.map((item: any) => ({
        id: normalizeOverviewItemId(item, "model-delta", usedIds),
        title: normalizeRichText(item?.title, canonicalFileId),
        before: normalizeRichText(item?.before, canonicalFileId),
        after: normalizeRichText(item?.after, canonicalFileId),
        refs: normalizeRefs(item?.refs, canonicalFileId),
      })).filter((item: any) => item.title || item.before || item.after || item.refs.length)
      : [],
    flows: Array.isArray(overview.flows)
      ? overview.flows.map((flow: any) => ({
        title: flow?.title || "",
        kind: flow?.kind || "before_after_ascii",
        lines: normalizeRichLines(flow?.lines, canonicalFileId),
        before: normalizeRichLines(flow?.before, canonicalFileId),
        after: normalizeRichLines(flow?.after, canonicalFileId),
      })).filter((flow: any) => flow.lines.length || flow.before.length || flow.after.length)
      : [],
    assumptions: Array.isArray(overview.assumptions)
      ? overview.assumptions.map((item: any) => ({
        id: normalizeOverviewItemId(item, "assumption", usedIds),
        text: normalizeRichText(item?.text, canonicalFileId),
        refs: normalizeRefs(item?.refs, canonicalFileId),
        evidence: normalizeFocusEvidence(item?.evidence, canonicalFileId),
        check: typeof item?.check === "string" ? item.check : undefined,
      }))
      : [],
    hotspots: Array.isArray(overview.hotspots)
      ? overview.hotspots.map((item: any) => ({
        id: normalizeOverviewItemId(item, "hotspot", usedIds),
        title: normalizeRichText(item?.title, canonicalFileId),
        why: normalizeRichText(item?.why, canonicalFileId),
        refs: normalizeRefs(item?.refs, canonicalFileId),
        evidence: normalizeFocusEvidence(item?.evidence, canonicalFileId),
        check: typeof item?.check === "string" ? item.check : undefined,
      }))
      : [],
  };
}

function normalizeSystemMap(systemMap: any, canonicalFileId: IdentityFileId = identityFileId): SystemMap | null {
  if (!systemMap || typeof systemMap !== "object" || Array.isArray(systemMap)) return null;
  const lines = normalizeRichLines(systemMap.lines, canonicalFileId);
  const refs = normalizeRefs(systemMap.refs, canonicalFileId);
  const title = typeof systemMap.title === "string" && systemMap.title.trim() ? systemMap.title.trim() : "Affected system";
  const kind = typeof systemMap.kind === "string" && systemMap.kind.trim() ? systemMap.kind.trim() : "ascii";
  if (!lines.length && !refs.length) return null;
  return { title, kind, lines, refs };
}

// Stable, content-anchored id (mirrors bin/aha.mjs overviewItemId). Author id
// wins; otherwise anchor on the primary evidence file + a short topic slug so the
// id tracks the concern, not its list position. Keeps triage state from sticking
// to a slot across regenerations. The CLI normalize bakes this id into the pack,
// so this client path is a parity fallback for un-normalized data.
function normalizeOverviewItemId(item: any, kind: string, used: Set<string>): string {
  const author = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : "";
  const base = author || contentAnchoredOverviewId(item, kind);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function contentAnchoredOverviewId(item: any, kind: string): string {
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  const anchor = evidence.find((entry: any) => entry && (entry.path || entry.fileId));
  const fileStem = anchor ? idSlug(stemOfPath(anchor.path || anchor.fileId)) : "";
  const topic = topicSlug(item?.title != null ? item.title : item?.text);
  const parts = [kind, fileStem, topic].filter(Boolean);
  return parts.length > 1 ? parts.join("-") : `${kind}-item`;
}

function rawRichToText(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part: any) => (typeof part === "string" ? part : (part && (part.label || part.id)) || "")).join(" ");
  }
  return "";
}

function topicSlug(value: any): string {
  return idSlug(rawRichToText(value)).split("-").filter(Boolean).slice(0, 4).join("-");
}

function idSlug(value: any): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stemOfPath(filePath: string): string {
  const base = String(filePath).split("/").pop() || "";
  return base.replace(/\.[^.]+$/, "");
}

function normalizeRichText(value: any, canonicalFileId: IdentityFileId = identityFileId): RichTextValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => normalizeRichPart(part, canonicalFileId)).filter(Boolean) as RichPart[];
  return "";
}

function normalizeRichLines(lines: any, canonicalFileId: IdentityFileId = identityFileId): RichTextValue[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => normalizeRichText(line, canonicalFileId)).filter((line) => line !== "");
}

function normalizeRefs(refs: any, canonicalFileId: IdentityFileId = identityFileId): RichRef[] {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref: any) => normalizeRef(ref, canonicalFileId))
    .filter(Boolean) as RichRef[];
}

function normalizeRichPart(part: any, canonicalFileId: IdentityFileId = identityFileId): RichPart | null {
  if (typeof part === "string") return part;
  return normalizeRef(part, canonicalFileId);
}

function normalizeRef(ref: any, canonicalFileId: IdentityFileId = identityFileId): RichRef | null {
  if (!ref || !["symbol", "file", "decision"].includes(ref.type) || typeof ref.id !== "string") return null;
  if (ref.type !== "file") return ref;
  const id = canonicalFileId(ref.id);
  return id ? { ...ref, id } : null;
}

function normalizeDecisionCards(cards: any, canonicalFileId: IdentityFileId = identityFileId): any[] {
  if (!Array.isArray(cards)) return [];
  const used = new Set<string>();
  return cards.map((card: any, index: number) => {
    const fallback = `dc-${slugId(card?.category || "decision")}-${index + 1}`;
    const rawId = typeof card?.id === "string" && card.id.trim() ? card.id.trim() : fallback;
    let id = rawId;
    let suffix = 2;
    while (used.has(id)) {
      id = `${rawId}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return {
      ...card,
      id,
      sections: normalizeDecisionSections(card?.sections, canonicalFileId),
    };
  });
}

function normalizeDecisionSections(sections: any, canonicalFileId: IdentityFileId = identityFileId): any {
  if (!Array.isArray(sections)) return [];
  return sections.map((section: any) => {
    if (!section || typeof section !== "object") return section;
    return {
      ...section,
      items: Array.isArray(section.items)
        ? section.items.map((item: any) => normalizeDecisionJump(item, canonicalFileId))
        : section.items,
    };
  });
}

function normalizeDecisionQuestions(questions: any, canonicalFileId: IdentityFileId = identityFileId): any[] {
  if (!Array.isArray(questions)) return [];
  return questions.map((question: any) => ({
    ...question,
    jumps: Array.isArray(question?.jumps)
      ? question.jumps.map((jump: any) => normalizeDecisionJump(jump, canonicalFileId))
      : question?.jumps,
  }));
}

function normalizeFocusEvidence(evidence: any, canonicalFileId: IdentityFileId = identityFileId): any[] | undefined {
  if (!Array.isArray(evidence)) return undefined;
  const items = evidence
    .filter((item) => item && typeof item === "object")
    .map((item: any) => normalizeDecisionJump(item, canonicalFileId));
  return items.length ? items : undefined;
}

function normalizeDecisionJump(item: any, canonicalFileId: IdentityFileId = identityFileId): any {
  if (!item || typeof item !== "object") return item;
  const rawPath = typeof item.path === "string" ? item.path : typeof item.fileId === "string" ? item.fileId : "";
  if (!rawPath) return item;
  const path = canonicalFileId(rawPath);
  if (!path) return item;
  const next = { ...item, path };
  delete next.fileId;
  return next;
}

function slugId(value: unknown): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function canonicalFileIdFor(files: PackFile[], fileAliasById: Record<string, string> = {}): CanonicalFileId {
  const fileIds = new Set(files.map((file) => file.id));
  const idByPath = new Map(files.map((file) => [file.path, file.id]));
  return (value: string) => {
    if (fileIds.has(value)) return value;
    if (idByPath.has(value)) return idByPath.get(value) ?? null;
    const aliasPath = fileAliasById[value];
    return aliasPath ? (idByPath.get(aliasPath) ?? null) : null;
  };
}

function dedupeFilesByPath(files: any[]): { files: PackFile[]; fileAliasById: Record<string, string> } {
  const byPath = new Map<string, PackFile>();
  const merged: PackFile[] = [];
  const fileAliasById: Record<string, string> = {};
  for (const [index, file] of files.entries()) {
    const path = file.path || file.id || `file-${index + 1}`;
    const id = file.id || `f-${index + 1}`;
    const existing = byPath.get(path);
    if (!existing) {
      const next = {
        ...file,
        id: path,
        path,
        notes: Array.isArray(file.notes) ? file.notes : [],
        diff: Array.isArray(file.diff) ? file.diff : [],
      };
      fileAliasById[id] = path;
      fileAliasById[path] = path;
      byPath.set(path, next);
      merged.push(next);
      continue;
    }
    fileAliasById[id] = existing.path;
    existing.add = (existing.add || 0) + (file.add || 0);
    existing.del = (existing.del || 0) + (file.del || 0);
    existing.diff.push(...(Array.isArray(file.diff) ? file.diff : []));
    existing.notes.push(...(Array.isArray(file.notes) ? file.notes : []));
  }
  return { files: merged, fileAliasById };
}

function diffFingerprintForFile(file: any): string {
  const payload = JSON.stringify({
    path: file?.path || "",
    tag: file?.tag || "",
    add: Number(file?.add) || 0,
    del: Number(file?.del) || 0,
    diff: Array.isArray(file?.diff)
      ? file.diff.map((line: DiffLine) => ({
        k: line.k,
        L: line.L ?? null,
        R: line.R ?? null,
        c: plainDiffContent(line.c),
      }))
      : [],
  });
  return `df1-${hashString(payload)}`;
}

function hashString(value: string): string {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function scrollToViewedFileHeader(file: PackFile, root: HTMLElement | null): void {
  if (!root || !file) return;
  const el = document.getElementById(file.id);
  if (!el) return;
  const stickyOffset = Number.parseFloat(getComputedStyle(root).getPropertyValue("--file-head-sticky-top")) || 0;
  const targetTop = el.offsetTop - stickyOffset - 8;
  root.scrollTo({
    top: Math.max(0, targetTop),
    behavior: "smooth",
  });
}

function buildCodeView(pr: Pr, readingMode: string): CodeView {
  const fileById = new Map(pr.files.map((file) => [file.id, file]));
  const selectedOrder = pr.readingOrders.find((order) => order.key === readingMode);
  if (!selectedOrder) {
    return buildFilesystemCodeView(pr.files);
  }

  const used = new Set<string>();
  const groups: CodeViewGroup[] = selectedOrder.groups.map((group) => {
    const groupFiles = group.files
      .map((fileId) => fileById.get(fileId))
      .filter((file): file is PackFile => Boolean(file))
      .filter((file) => {
        if (used.has(file.id)) return false;
        used.add(file.id);
        return true;
      });
    return { ...group, files: groupFiles };
  });
  const missingFiles = pr.files.filter((file) => !used.has(file.id));
  if (missingFiles.length > 0) {
    groups.push({
      key: "remaining",
      label: "Remaining files",
      why: "files not placed in the selected reading order",
      files: missingFiles,
    });
  }
  return {
    files: groups.flatMap((group) => group.files),
    groups,
  };
}

function buildFilesystemCodeView(files: PackFile[]): CodeView {
  const sortedFiles = [...files].sort((a, b) => String(a.path || "").localeCompare(String(b.path || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  }));
  const groupMap = new Map<string, CodeViewGroup>();
  for (const file of sortedFiles) {
    const folder = dirname(file.path) || "Root";
    if (!groupMap.has(folder)) {
      groupMap.set(folder, {
        key: `fs:${folder}`,
        label: folder,
        why: "",
        files: [],
      });
    }
    groupMap.get(folder)!.files.push(file);
  }
  const groups = Array.from(groupMap.values()).map((group) => ({
    ...group,
    why: `${group.files.length} ${group.files.length === 1 ? "file" : "files"}`,
  }));
  return { files: sortedFiles, groups };
}

interface RailFilterOptions {
  reviewSignals: ReviewSignals | undefined;
  includeNoise: boolean;
  includeViewed: boolean;
  reviewedSet: Set<string>;
}

// Shrink the code view to "what still needs attention": optionally drop
// likely-noise files and/or files already marked viewed. Drives both the rail
// and the center document so the two stay in lockstep.
function applyRailFilters(codeView: CodeView, opts: RailFilterOptions): CodeView {
  const { reviewSignals, includeNoise, includeViewed, reviewedSet } = opts;
  if (includeNoise && includeViewed) return codeView;
  const isVisible = (file: PackFile) => {
    if (!includeNoise && isNoiseSignal(reviewSignals?.files?.[fileSignalKey(file)])) return false;
    if (!includeViewed && reviewedSet.has(fileReviewKey(file))) return false;
    return true;
  };
  const groups = codeView.groups
    .map((group) => ({
      ...group,
      files: group.files.filter(isVisible),
    }))
    .filter((group) => group.files.length > 0);
  return {
    files: codeView.files.filter(isVisible),
    groups,
  };
}

function normalizeReadingOrders(readingOrders: any, files: PackFile[], fileAliasById: Record<string, string> = {}): ReadingOrder[] {
  if (!Array.isArray(readingOrders)) return [];
  const fileIds = new Set(files.map((file) => file.id));
  const idByPath = new Map(files.map((file) => [file.path, file.id]));
  const canonicalFileId = (value: string): string | null => {
    if (fileIds.has(value)) return value;
    const aliasPath = fileAliasById[value];
    return aliasPath ? (idByPath.get(aliasPath) ?? null) : null;
  };
  return readingOrders
    .map((order: any, index: number): ReadingOrder => {
      const key = order?.key || `reading-order-${index + 1}`;
      const groups = Array.isArray(order?.groups) ? order.groups : [];
      return {
        key,
        label: order?.label || "AI reading order",
        why: order?.why || "low-friction path through the files",
        groups: groups.map((group: any, groupIndex: number) => ({
          key: group?.key || `${key}-${groupIndex + 1}`,
          label: group?.label || `Step ${groupIndex + 1}`,
          why: group?.why || "",
          files: Array.isArray(group?.files)
            ? Array.from(new Set(group.files.map(canonicalFileId).filter(Boolean))) as string[]
            : [],
        })),
      };
    })
    .filter((order) => order.groups.some((group) => group.files.length > 0));
}

function readStoredObject(key: string): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") || {};
  } catch {
    return {};
  }
}

function readStoredNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? clampRailWidth(value) : fallback;
}

function defaultLeftRailWidth(): number {
  if (typeof window === "undefined") return 300;
  if (window.innerWidth <= 980) return 230;
  if (window.innerWidth <= 1180) return 260;
  return 300;
}

function defaultRightRailWidth(): number {
  if (typeof window === "undefined") return 340;
  if (window.innerWidth <= 1180) return 320;
  return 340;
}

function clampRailWidth(value: number): number {
  if (typeof window === "undefined") return Math.max(220, Math.min(900, value));
  // Allow a much wider rail than before — the file-diff panel needs room to be
  // readable (code wraps badly when narrow).
  const max = Math.min(1000, Math.max(360, Math.floor(window.innerWidth * 0.7)));
  const min = window.innerWidth <= 980 ? 200 : 220;
  return Math.max(min, Math.min(max, Math.round(value)));
}

interface CanonicalReviewLookup {
  fileIds: Set<string>;
  filePaths: Set<string>;
  pathById: Map<string, string>;
}

function normalizeReviewState(input: any, pr: Pr): ReviewState {
  const fileIds = new Set(pr.files.map((file) => file.id));
  const filePaths = new Set(pr.files.map((file) => file.path));
  const filesByPath = new Map(pr.files.map((file) => [fileReviewKey(file), file]));
  const pathById = new Map<string, string>([
    ...pr.files.map((file) => [file.id, file.path] as [string, string]),
    ...Object.entries(pr._fileAliasById || {}),
  ]);
  const lookup: CanonicalReviewLookup = { fileIds, filePaths, pathById };
  const actionIds = new Set<string>([
    ...pr.decisions.cards.map((card) => card.id),
    ...(pr.overview?.assumptions || []).map((item) => item.id),
    ...(pr.overview?.hotspots || []).map((item) => item.id),
  ].filter(Boolean));
  const viewedFiles: Record<string, ViewedFileEntry> = {};
  const viewed = new Set<string>();
  const changedViewed = new Set<string>();
  const legacyViewed = Array.isArray(input?.viewed)
    ? input.viewed.map((value: unknown) => canonicalReviewPath(value, lookup)).filter((p: string | null): p is string => Boolean(p))
    : [];
  const inputViewedFiles: Record<string, any> = input?.viewedFiles && typeof input.viewedFiles === "object" ? input.viewedFiles : {};
  for (const [rawFileId, entry] of Object.entries(inputViewedFiles)) {
    const filePath = canonicalReviewPath(rawFileId, lookup);
    const file = filePath ? filesByPath.get(filePath) : null;
    if (!file || !filePath || !entry || typeof entry !== "object") continue;
    const diffFingerprint = typeof entry.diffFingerprint === "string" ? entry.diffFingerprint : "";
    if (!diffFingerprint) continue;
    viewedFiles[filePath] = {
      diffFingerprint,
      viewedAt: typeof entry.viewedAt === "string" ? entry.viewedAt : "",
    };
    if (diffFingerprint === (file.diffFingerprint || diffFingerprintForFile(file))) {
      viewed.add(filePath);
    } else {
      changedViewed.add(filePath);
    }
  }
  for (const filePath of legacyViewed) {
    if (viewedFiles[filePath]) continue;
    const file = filesByPath.get(filePath);
    if (!file) continue;
    viewed.add(filePath);
    viewedFiles[filePath] = {
      diffFingerprint: file.diffFingerprint || diffFingerprintForFile(file),
      viewedAt: typeof input?.updatedAt === "string" ? input.updatedAt : "",
    };
  }
  const decisions: Record<string, TriageStatus> = {};
  if (input?.decisions && typeof input.decisions === "object") {
    for (const [id, status] of Object.entries(input.decisions)) {
      if (actionIds.has(id) && (status === "accept" || status === "flag" || status === "block")) {
        decisions[id] = status;
      }
    }
  }
  const baselines: Record<string, FocusBaseline> = {};
  if (input?.baselines && typeof input.baselines === "object") {
    for (const [id, raw] of Object.entries(input.baselines as Record<string, any>)) {
      // Only keep baselines for items still triaged — a dropped triage has no baseline.
      if (!decisions[id] || !raw || typeof raw !== "object") continue;
      const lens = raw.lens === "decide" || raw.lens === "inspect" || raw.lens === "verify" ? raw.lens : "decide";
      baselines[id] = {
        lens,
        title: typeof raw.title === "string" ? raw.title : "",
        body: typeof raw.body === "string" ? raw.body : "",
        check: typeof raw.check === "string" ? raw.check : "",
        at: typeof raw.at === "string" ? raw.at : "",
      };
    }
  }
  return { viewed: Array.from(viewed), viewedFiles, changedViewed: Array.from(changedViewed), decisions, baselines };
}

function readLocalReviewState(pr: Pr, reviewStateKey: string, legacyReviewStateStorageKey: string, legacyStatusStorageKey: string): ReviewState {
  const primaryState = readStoredObject(reviewStateKey);
  const legacyState = legacyReviewStateStorageKey !== reviewStateKey ? readStoredObject(legacyReviewStateStorageKey) : {};
  const state = hasStoredReviewState(primaryState) ? primaryState : legacyState;
  const legacyDecisions = readStoredObject(legacyStatusStorageKey);
  return normalizeReviewState({
    viewed: state.viewed,
    viewedFiles: state.viewedFiles,
    decisions: { ...legacyDecisions, ...(state.decisions || {}) },
    baselines: state.baselines,
    updatedAt: state.updatedAt,
  }, pr);
}

function hasStoredReviewState(state: any): boolean {
  return Array.isArray(state?.viewed) || (state?.viewedFiles && typeof state.viewedFiles === "object") || (state?.decisions && typeof state.decisions === "object");
}

function canonicalReviewPath(value: unknown, { fileIds, filePaths, pathById }: CanonicalReviewLookup): string | null {
  if (typeof value !== "string") return null;
  if (filePaths.has(value)) return value;
  if (fileIds.has(value) || pathById.has(value)) return pathById.get(value) ?? null;
  return null;
}

function reviewStateScope(pr: Pr): string {
  const url = typeof pr.url === "string" && pr.url ? pr.url : extractUrl(pr.oneLiner);
  const raw = [
    url,
    pr.number || "",
    pr.branch || "",
    pr.base || "",
    pr.title || "",
  ].filter(Boolean).join("|") || "unknown";
  return slugForStorage(raw);
}

function extractUrl(value: unknown): string {
  return String(value || "").match(/https?:\/\/\S+/)?.[0] || "";
}

function slugForStorage(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "unknown";
}

function persistReviewState(key: string, state: PersistedReviewState, selectedPackId = ""): void {
  localStorage.setItem(key, JSON.stringify(state));
  fetch(packUrl("/aha-state.json", selectedPackId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  }).catch(() => {});
}

type TweakValue = string | boolean;

function useTweaks(defaults: Tweaks): [Tweaks, (key: keyof Tweaks, value: TweakValue) => void] {
  const [values, setValues] = useState<Tweaks>(() => ({
    ...defaults,
    ...readStoredObject("aha:tweaks"),
  }));

  const setTweak = useCallback((key: keyof Tweaks, value: TweakValue) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem("aha:tweaks", JSON.stringify(next));
      return next;
    });
  }, []);

  return [values, setTweak];
}

// Apply the stored theme (default dark) to <body> before React mounts so the
// dashboard, onboarding, and loading screens — which render outside <App> — are
// themed too, not just the viewer. App keeps it in sync on toggle.
function applyStoredTheme(): void {
  const stored = readStoredObject("aha:tweaks");
  const theme = typeof stored.theme === "string" ? stored.theme : TWEAK_DEFAULTS.theme;
  document.body.classList.toggle("theme-dark", theme === "dark");
}

applyStoredTheme();
createRoot(document.getElementById("root")!).render(<AhaLoader />);
