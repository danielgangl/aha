import React, { useCallback, useMemo, useState } from "react";
import type {
  CodeViewGroup,
  FileJumpHandler,
  PackFile,
  ReadingOrder,
  ReviewSignals,
  TreeNode,
} from "../types";
import {
  basename,
  fileMatchesSearch,
  fileReviewKey,
  fileSignalKey,
  isNoiseSignal,
  normalizeFileSearch,
} from "../lib/pack";

export function buildFileTree(files: PackFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = String(file.path || "").split("/").filter(Boolean);
    parts.pop();
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!node.folders.has(part)) {
        node.folders.set(part, { name: part, path: acc, folders: new Map(), files: [] });
      }
      node = node.folders.get(part)!;
    }
    node.files.push(file);
  }
  for (const child of root.folders.values()) compressTreeFolder(child);
  return root;
}

// Collapse single-child folder chains (src → components → ...) into one row.
export function compressTreeFolder(folder: TreeNode) {
  for (const child of folder.folders.values()) compressTreeFolder(child);
  while (folder.files.length === 0 && folder.folders.size === 1) {
    const child = folder.folders.values().next().value as TreeNode;
    folder.name = `${folder.name}/${child.name}`;
    folder.path = child.path;
    folder.files = child.files;
    folder.folders = child.folders;
  }
}

export function countTreeFiles(node: TreeNode): number {
  let count = node.files.length;
  for (const child of node.folders.values()) count += countTreeFiles(child);
  return count;
}

// ── Reusable: badge (file type / state pill) ──────────────────
type BadgeTone = "blue" | "muted";
function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  const toneCls =
    tone === "muted" ? "bg-bg-3 text-ink-3" : "bg-blue-soft text-blue-ink";
  return (
    <span
      className={`font-mono text-[9px] font-semibold tracking-[0.03em] rounded-[3px] px-1 py-px ${toneCls}`}
    >
      {children}
    </span>
  );
}

// ── Reusable: caret + folder glyph (pseudo-element art as JSX) ─
// .rl-folder-caret — 10x10 box, ::before is a rotated chevron corner.
function FolderCaret({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative w-2.5 h-2.5 flex-none text-ink-4 group-hover:text-ink-3 transition-transform duration-[0.12s] ease-[ease] ${
        open ? "rotate-90" : ""
      }`}
    >
      <span className="absolute left-0.5 top-0.5 w-1 h-1 border-t-[1.4px] border-r-[1.4px] border-current rotate-45" />
    </span>
  );
}

// .rl-folder-ico — 14x11 box; ::before tab, ::after body.
function FolderIcon({ open }: { open: boolean }) {
  // open state recolors the glyph from ink-4 to ink-3.
  const fill = open ? "bg-ink-3" : "bg-ink-4";
  return (
    <span aria-hidden="true" className="relative w-3.5 h-[11px] flex-none">
      <span className={`absolute left-0 top-0 w-1.5 h-[3px] rounded-t-[1.5px] ${fill}`} />
      <span
        className={`absolute left-0 top-0.5 w-3.5 h-[9px] rounded-[1px_2px_2px_2px] ${fill}`}
      />
    </span>
  );
}

interface RlFileProps {
  activeId: string | null;
  reviewedSet: Set<string>;
  changedViewedSet: Set<string>;
  reviewSignals: ReviewSignals | undefined;
  onJump: FileJumpHandler;
}

export function RlFileRow({
  file,
  depth,
  activeId,
  reviewedSet,
  changedViewedSet,
  reviewSignals,
  onJump,
}: { file: PackFile; depth?: number } & RlFileProps) {
  const noise = isNoiseSignal(reviewSignals?.files?.[fileSignalKey(file)]);
  const changed = changedViewedSet?.has(fileReviewKey(file));
  return (
    <div
      className={[
        "relative flex items-center gap-1.5 cursor-pointer select-none font-mono text-[11.5px]",
        "py-1 pr-3 pl-[22px] border-l-2 border-l-transparent",
        "text-blue-ink hover:bg-bg-3",
        // active
        "data-[active=true]:bg-surface data-[active=true]:border-l-blue data-[active=true]:text-blue-ink",
        // read (overrides color; strike handled on name)
        "data-[read=true]:text-ink-3",
        // noise (only when not read)
        "data-[noise=true]:data-[read=false]:text-ink-4",
        // changed-viewed (only when not read and not noise)
        "data-[changed-viewed=true]:data-[read=false]:data-[noise=false]:text-blue-ink",
      ].join(" ")}
      style={depth != null ? { paddingLeft: 10 + depth * 14 } : undefined}
      data-active={activeId === file.id}
      data-noise={noise}
      data-read={reviewedSet.has(fileReviewKey(file))}
      data-changed-viewed={changed}
      onClick={() => onJump(file.id)}
      title={file.path}
    >
      {/* .dot — recolors via parent data-state */}
      <span
        data-noise={noise}
        data-read={reviewedSet.has(fileReviewKey(file))}
        data-changed-viewed={changed}
        className={[
          "w-1.5 h-1.5 rounded-full shrink-0 bg-blue",
          "data-[read=true]:bg-pine",
          "data-[noise=true]:data-[read=false]:bg-line-3",
          "data-[changed-viewed=true]:data-[read=false]:bg-blue",
        ].join(" ")}
      />
      <span
        data-read={reviewedSet.has(fileReviewKey(file))}
        className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap data-[read=true]:line-through data-[read=true]:decoration-ink-4"
      >
        {basename(file.path)}
      </span>
      {file.tag === "new" && <Badge tone="blue">NEW</Badge>}
      {file.tag === "unchanged" && <Badge tone="muted">CTX</Badge>}
      {changed && <Badge tone="blue">CHANGED</Badge>}
      {noise && <Badge tone="muted">NOISE</Badge>}
      {(file.add ?? 0) > 0 || (file.del ?? 0) > 0 ? (
        <span className="shrink-0 text-[10px] text-ink-4 [font-variant-numeric:tabular-nums]">
          {(file.add ?? 0) > 0 && <span className="text-pine-ink">+{file.add}</span>}
          {(file.del ?? 0) > 0 && <span className="text-rose-ink">−{file.del}</span>}
        </span>
      ) : null}
    </div>
  );
}

export function RlTreeNode({
  node,
  depth,
  collapsed,
  forceOpen,
  toggleFolder,
  fileProps,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  forceOpen: boolean;
  toggleFolder: (path: string) => void;
  fileProps: RlFileProps;
}) {
  return (
    <>
      {Array.from(node.folders.values()).map((folder) => {
        const open = forceOpen || !collapsed.has(folder.path);
        return (
          <React.Fragment key={folder.path}>
            <div
              className="group flex items-center gap-1.5 py-1 px-3 cursor-pointer select-none text-ink-2 border-l-2 border-l-transparent hover:bg-bg-3"
              data-open={open}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => toggleFolder(folder.path)}
              title={folder.path}
            >
              <FolderCaret open={open} />
              <FolderIcon open={open} />
              <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px] text-ink-2">
                {folder.name}
              </span>
              <span className="flex-none font-mono text-[10px] text-ink-4 [font-variant-numeric:tabular-nums]">
                {countTreeFiles(folder)}
              </span>
            </div>
            {open && (
              <RlTreeNode
                node={folder}
                depth={depth + 1}
                collapsed={collapsed}
                forceOpen={forceOpen}
                toggleFolder={toggleFolder}
                fileProps={fileProps}
              />
            )}
          </React.Fragment>
        );
      })}
      {node.files.map((file) => (
        <RlFileRow key={file.id} file={file} depth={depth} {...fileProps} />
      ))}
    </>
  );
}

// ── Reusable: small switch button (reading-order / noise) ──────
function SwitchButton({
  active,
  disabled,
  small,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  small?: boolean;
  onClick?: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-active={active}
      onClick={onClick}
      title={title}
      className={[
        "min-w-0 h-6 border border-line rounded-[5px] bg-surface text-ink-3 cursor-pointer",
        small ? "px-[5px] text-[10.5px]" : "text-[11px]",
        "data-[active=true]:border-ink data-[active=true]:text-ink data-[active=true]:bg-paper",
        "disabled:cursor-not-allowed disabled:text-ink-4 disabled:bg-bg-2",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

// ── Reusable: filter checkbox (Viewed / Noise) ─────────────────
// Mirrors the file-head "Viewed" pill: a 14px box that fills + shows a ✓
// when on. Optional trailing count; disabled state dims the whole pill.
function FilterCheckbox({
  label,
  on,
  disabled,
  count,
  onClick,
  title,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  count?: number;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-on={on}
      onClick={onClick}
      title={title}
      className={[
        "group/cb inline-flex h-[22px] items-center gap-[6px] text-[11px] text-ink-2 cursor-pointer select-none transition-colors",
        "hover:text-ink",
        "data-[on=true]:text-ink",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-ink-2",
      ].join(" ")}
    >
      <span className="inline-flex h-[14px] w-[14px] items-center justify-center rounded-[3px] border-[1.5px] border-ink-4 bg-surface font-sans text-[11px] font-bold leading-none group-data-[on=true]/cb:border-ink group-data-[on=true]/cb:bg-ink group-data-[on=true]/cb:text-bg group-data-[on=true]/cb:after:content-['✓']" />
      <span>{label}</span>
      {count != null && (
        <span className="font-mono text-[10px] text-ink-4 [font-variant-numeric:tabular-nums] group-data-[on=true]/cb:text-ink-3">
          {count}
        </span>
      )}
    </button>
  );
}

// ── Left rail: file list grouped by reading-order phase ────────
export function LeftRail({
  files,
  groups,
  activeId,
  reviewedSet,
  changedViewedSet,
  onJump,
  readingOrders,
  readingMode,
  onReadingModeChange,
  reviewSignals,
  includeViewed,
  onIncludeViewedChange,
  includeNoise,
  onIncludeNoiseChange,
  noiseFileCount,
  totalFileCount,
  reviewedCount,
  hiddenByFilters,
}: {
  files: PackFile[];
  groups: CodeViewGroup[];
  activeId: string | null;
  reviewedSet: Set<string>;
  changedViewedSet: Set<string>;
  onJump: FileJumpHandler;
  readingOrders: ReadingOrder[];
  readingMode: string;
  onReadingModeChange: (mode: string) => void;
  reviewSignals: ReviewSignals | undefined;
  includeViewed: boolean;
  onIncludeViewedChange: (next: boolean) => void;
  includeNoise: boolean;
  onIncludeNoiseChange: (next: boolean) => void;
  noiseFileCount: number;
  totalFileCount: number;
  reviewedCount: number;
  hiddenByFilters: number;
}) {
  const [fileQuery, setFileQuery] = useState("");
  const reviewedPct = totalFileCount > 0 ? (reviewedCount / totalFileCount) * 100 : 0;
  const hasAiOrder = readingOrders.length > 0;
  const activeOrder = readingOrders.find((order) => order.key === readingMode);
  const normalizedQuery = normalizeFileSearch(fileQuery);
  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return groups;
    return groups
      .map((group) => ({
        ...group,
        files: group.files.filter((file) => fileMatchesSearch(file, normalizedQuery)),
      }))
      .filter((group) => group.files.length > 0);
  }, [groups, normalizedQuery]);
  const visibleFileCount = visibleGroups.reduce((sum, group) => sum + group.files.length, 0);
  const firstSearchMatch = normalizedQuery ? visibleGroups[0]?.files[0] : null;

  const isFilesystem = readingMode === "default";
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const toggleFolder = useCallback((path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const visibleFiles = useMemo(
    () => (normalizedQuery ? files.filter((file) => fileMatchesSearch(file, normalizedQuery)) : files),
    [files, normalizedQuery]
  );
  const fileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);

  return (
    <aside className="relative border-r border-line bg-rail overflow-y-auto text-[12px]">
      <div className="px-3.5 pt-3 pb-2 border-b border-line flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">
          Files in this PR
        </span>
        <span className="font-mono text-[10.5px] text-ink-3">
          {normalizedQuery
            ? `${visibleFileCount}/${files.length}`
            : files.length === totalFileCount
              ? totalFileCount
              : `${files.length} of ${totalFileCount}`}
        </span>
      </div>
      <div className="px-2.5 py-2 border-b border-line">
        <input
          className="w-full h-[26px] px-2 bg-surface border border-line-2 rounded-md text-[12px] text-ink outline-none placeholder:text-ink-4"
          value={fileQuery}
          placeholder="Search file name or path"
          onChange={(event) => setFileQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && firstSearchMatch) {
              event.preventDefault();
              onJump(firstSearchMatch.id);
            }
            if (event.key === "Escape" && fileQuery) {
              event.preventDefault();
              setFileQuery("");
            }
          }}
        />
      </div>
      {/* ── Arrange: how the surviving files are ordered ── */}
      <div className="grid grid-cols-2 gap-1 px-2.5 pt-2 pb-1.5">
        <SwitchButton
          active={readingMode === "default"}
          onClick={() => onReadingModeChange("default")}
          title="Order files by folder path"
        >
          Filesystem
        </SwitchButton>
        <SwitchButton
          disabled={!hasAiOrder}
          active={readingMode !== "default"}
          onClick={() => hasAiOrder && onReadingModeChange(readingOrders[0].key)}
          title={hasAiOrder ? activeOrder?.why || readingOrders[0].why : "Grouped order unavailable"}
        >
          Grouped
        </SwitchButton>
      </div>
      {/* ── Filters: shrink the list to what still needs attention ── */}
      <div className="flex items-center gap-4 px-2.5 pb-2 pt-1 border-b border-line">
        <FilterCheckbox
          label="Viewed"
          on={includeViewed}
          onClick={() => onIncludeViewedChange(!includeViewed)}
          title="Keep files you've marked viewed in the list (struck through). Uncheck to hide them and focus on what's left."
        />
        <FilterCheckbox
          label="Noise"
          on={includeNoise}
          disabled={noiseFileCount === 0}
          count={noiseFileCount || undefined}
          onClick={() => onIncludeNoiseChange(!includeNoise)}
          title={
            noiseFileCount > 0
              ? "Show low-signal files flagged as likely review-irrelevant (lockfiles, generated output, etc.)."
              : "No likely-noise files in this PR"
          }
        />
        {hiddenByFilters > 0 && !normalizedQuery && (
          <span className="ml-auto font-mono text-[10px] text-ink-4 [font-variant-numeric:tabular-nums]">
            · {hiddenByFilters} hidden
          </span>
        )}
      </div>

      {isFilesystem ? (
        <div className="pt-1 pb-0.5">
          <RlTreeNode
            node={fileTree}
            depth={0}
            collapsed={collapsedFolders}
            forceOpen={!!normalizedQuery}
            toggleFolder={toggleFolder}
            fileProps={{ activeId, reviewedSet, changedViewedSet, reviewSignals, onJump }}
          />
        </div>
      ) : (
        visibleGroups.map((g, gi) => {
          if (!g.files.length) return null;
          return (
            <div className="pt-1.5" key={g.key}>
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-[7px] gap-y-1 px-3.5 pt-[9px] pb-1 text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">
                <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-[3px] rounded-[5px] border border-line bg-surface font-mono text-[9.5px] font-semibold tabular-nums text-ink-2 shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
                  {gi + 1}
                </span>
                <span>{g.label}</span>
                <span className="col-span-full text-ink-4 font-normal tracking-normal normal-case text-[10px] leading-[1.3] min-w-0">
                  {g.why}
                </span>
              </div>
              {g.files.map((f) => (
                <RlFileRow
                  key={f.id}
                  file={f}
                  activeId={activeId}
                  reviewedSet={reviewedSet}
                  changedViewedSet={changedViewedSet}
                  reviewSignals={reviewSignals}
                  onJump={onJump}
                />
              ))}
            </div>
          );
        })
      )}

      {normalizedQuery && visibleFileCount === 0 && (
        <div className="px-3.5 py-3 text-ink-4 text-[11px] leading-[1.4]">
          No files match "{fileQuery.trim()}"
        </div>
      )}

      {!normalizedQuery && files.length === 0 && (
        <div className="px-3.5 py-6 text-center text-[11.5px] leading-[1.5] text-ink-3">
          {reviewedCount >= totalFileCount && totalFileCount > 0
            ? "✓ Every file reviewed."
            : "Nothing left to show."}
          {hiddenByFilters > 0 && (
            <div className="mt-1 text-[10.5px] text-ink-4">
              {hiddenByFilters} {hiddenByFilters === 1 ? "file" : "files"} hidden by filters
            </div>
          )}
        </div>
      )}

      <div className="sticky bottom-0 px-3.5 py-2.5 border-t border-line bg-rail flex items-center gap-2 text-[11px]">
        <span className="font-mono text-ink-2 text-[11px]">
          {reviewedCount}/{totalFileCount}
        </span>
        <span className="flex-1 h-1 bg-bg-3 rounded-[2px] overflow-hidden">
          <span className="block h-full bg-ink rounded-[2px]" style={{ width: `${reviewedPct}%` }} />
        </span>
      </div>
    </aside>
  );
}
