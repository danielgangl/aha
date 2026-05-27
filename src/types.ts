/// <reference types="vite/client" />

// Shared types for the aha viewer "pack" JSON shape and review state.
// The pack is loosely-validated JSON, so many fields are optional / permissive.

export type DiffKind = "add" | "del" | "ctx" | "hunk";

export type SymbolTokenPart = {
  __sym?: boolean;
  type?: string;
  id: string;
  label: string;
};

export type DiffContent = string | Array<string | SymbolTokenPart>;

export interface DiffLine {
  k: DiffKind;
  L?: number | null;
  R?: number | null;
  c: DiffContent;
}

export interface FileNote {
  html: string;
  src?: string;
  afterL?: number | null;
  afterR?: number | null;
}

export interface PackFile {
  id: string;
  path: string;
  tag?: string;
  add?: number;
  del?: number;
  note?: string;
  diff: DiffLine[];
  notes: FileNote[];
  group?: string;
  groupReason?: string;
  diffFingerprint?: string;
}

export interface SymbolLocationContextLine {
  line: number;
  c: string;
}

export interface SymbolCaller {
  path?: string;
  file?: string;
  fileId?: string;
  line?: number;
  inPR?: boolean;
  status?: "touched" | "untouched" | "test" | string;
  role?: "read" | "write" | string;
  why?: string;
  context: { lines: SymbolLocationContextLine[] };
}

export interface SymbolDefined {
  path?: string;
  file?: string;
  fileId?: string;
  line?: number;
}

export interface PackSymbol {
  name: string;
  kind: string;
  signature?: string;
  summary?: string;
  defined: SymbolDefined;
  callers: SymbolCaller[];
  notCallers?: SymbolCaller[];
}

export type SymbolMap = Record<string, PackSymbol>;

export type Relevance = "noise" | "normal" | "context";

export interface SignalScope {
  before: string;
  after: string;
}

export interface SideAnchor {
  path?: string;
  start: number;
  end: number;
}

export interface RangeAnchor {
  left: SideAnchor | null;
  right: SideAnchor | null;
}

export interface SignalRange {
  id: string;
  relevance: Relevance;
  source: string;
  kind?: string;
  hideByDefault: boolean;
  reason: string;
  scope: SignalScope | null;
  patternId?: string;
  anchor: RangeAnchor;
}

export interface FileSignal {
  relevance: Relevance;
  source: string;
  hideByDefault: boolean;
  categories: string[];
  reason: string;
  ranges: SignalRange[];
}

export interface ReviewSignalPattern {
  id: string;
  label: string;
  source: string;
  description: string;
}

export interface ReviewSignals {
  version: number;
  patterns: Record<string, ReviewSignalPattern>;
  summary: {
    noiseFiles: number;
    noiseLines: number;
    primaryFiles: number;
  };
  files: Record<string, FileSignal>;
}

export type RefType = "symbol" | "file" | "decision";

export interface RichRef {
  type: RefType;
  id: string;
  label?: string;
}

export type RichPart = string | RichRef;
export type RichText = string | RichPart[];

export interface ModelDelta {
  id: string;
  title: RichText;
  before: RichText;
  after: RichText;
  refs: RichRef[];
}

export interface SystemMap {
  title: string;
  kind: string;
  lines: RichText[];
  refs: RichRef[];
}

export interface OverviewFlow {
  title: string;
  kind: string;
  lines: RichText[];
  before: RichText[];
  after: RichText[];
}

export interface OverviewAssumption {
  id: string;
  text: RichText;
  refs: RichRef[];
}

export interface OverviewHotspot {
  id: string;
  title: RichText;
  why: RichText;
  refs: RichRef[];
}

export interface Overview {
  mentalModelDelta: RichText;
  systemMap: SystemMap | null;
  modelDeltas: ModelDelta[];
  flows: OverviewFlow[];
  assumptions: OverviewAssumption[];
  hotspots: OverviewHotspot[];
}

export interface DecisionJump {
  path?: string;
  fileId?: string;
  line?: number;
  ref?: string;
  desc?: string;
}

export interface DecisionSection {
  kind?: string;
  label?: string;
  text?: string;
  items?: DecisionJump[];
}

export interface DecisionCardData {
  id: string;
  category?: string;
  risk?: string;
  title?: string;
  claim?: string;
  whyItMatters?: string;
  sections: DecisionSection[];
}

export interface DecisionCategory {
  key: string;
  label?: string;
  why?: string;
}

export interface DecisionQuestion {
  id?: string;
  text?: string;
  jumps?: DecisionJump[];
}

export interface Decisions {
  categories: DecisionCategory[];
  cards: DecisionCardData[];
  questions: DecisionQuestion[];
}

export interface ReadingOrderGroup {
  key: string;
  label: string;
  why: string;
  files: string[];
}

export interface ReadingOrder {
  key: string;
  label: string;
  why: string;
  groups: ReadingOrderGroup[];
}

export interface PrAuthor {
  name: string;
  initials?: string;
}

export interface Pr {
  schemaVersion: string;
  files: PackFile[];
  _fileAliasById: Record<string, string>;
  symbols: SymbolMap;
  groups: unknown[];
  readingOrders: ReadingOrder[];
  overview: Overview | null;
  reviewSignals: ReviewSignals;
  decisions: Decisions;
  repositoryName: string;
  repository?: { name?: string };
  author: PrAuthor;
  filesChanged: number;
  added: number;
  removed: number;
  number?: string | number;
  title?: string;
  oneLiner?: string;
  branch?: string;
  base?: string;
  url?: string;
}

export interface Runtime {
  ahaCli: string;
}

export type TriageStatus = "accept" | "flag" | "block";

export interface ViewedFileEntry {
  diffFingerprint: string;
  viewedAt: string;
}

export interface ReviewState {
  viewed: string[];
  viewedFiles: Record<string, ViewedFileEntry>;
  changedViewed: string[];
  decisions: Record<string, TriageStatus>;
}

export interface PersistedReviewState {
  schemaVersion: string;
  viewed: string[];
  viewedFiles: Record<string, ViewedFileEntry>;
  decisions: Record<string, TriageStatus>;
  updatedAt: string;
}

// A built view of files grouped for display.
export interface CodeViewGroup {
  key: string;
  label: string;
  why: string;
  files: PackFile[];
}

export interface CodeView {
  files: PackFile[];
  groups: CodeViewGroup[];
}

// Tree node used by the filesystem rail.
export interface TreeNode {
  name: string;
  path: string;
  folders: Map<string, TreeNode>;
  files: PackFile[];
}

// A copy-block descriptor produced for a diff line/side.
export interface CopyBlock {
  id: string;
  isStart: boolean;
  isEnd: boolean;
  text: string;
}

// A side-by-side diff row.
export interface DiffRowData {
  kind: string;
  line?: DiffLine;
  left?: DiffLine | null;
  right?: DiffLine | null;
}

export type CanonicalFileId = (value: string) => string | null;

// ── Shared UI handler / view helper types ──────────────────────
export type DiffSide = "left" | "right";
export type SymbolHandler = (id: string) => void;
export type FileJumpHandler = (fileId: string, line?: number) => void;
export type DecisionHandler = (id: string) => void;
export type SetStatusHandler = (status: TriageStatus | null) => void;
export type StatusMap = Record<string, TriageStatus>;
export type NoiseMode = "focus" | "all" | "expanded";

export interface RichHandlers {
  onSymbol: SymbolHandler;
  onFile: FileJumpHandler;
  onDecision: DecisionHandler;
}
