import type { PackFile, SymbolHandler, SymbolMap } from "../types";
import { basename } from "../lib/pack";
import { DiffExcerpt } from "./diff";

// Right-rail panel that shows a file's diff in place. Opened from High Level so
// a file reference enriches the current view instead of switching to the Code
// tab — the reviewer stays in flow and same focus.
export function FileDiffPanel({
  file,
  line,
  symbols,
  onSymbol,
  onClose,
  onOpenInCode,
}: {
  file: PackFile | null;
  line: number | null;
  symbols: SymbolMap | undefined;
  onSymbol: SymbolHandler;
  onClose: () => void;
  onOpenInCode: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <header className="sticky top-0 z-[1] flex items-center gap-2 px-3 py-[10px] border-b border-line bg-rail">
        <span className="flex-1 min-w-0 font-mono text-[11.5px] text-ink truncate" title={file?.path}>
          {file ? basename(file.path) : "File"}
        </span>
        {file && (
          <button
            type="button"
            onClick={onOpenInCode}
            title="Open in Code tab"
            className="w-6 h-6 grid place-items-center rounded-[5px] border-0 bg-transparent text-ink-3 font-mono text-[12px] cursor-pointer hover:bg-bg-3 hover:text-ink"
          >
            ↗
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="w-6 h-6 grid place-items-center rounded-[5px] border-0 bg-transparent text-ink-3 text-[18px] leading-none cursor-pointer hover:bg-bg-3 hover:text-ink"
        >
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {file ? (
          <>
            <div className="mb-2 font-mono text-[10.5px] text-ink-4 truncate" title={file.path}>{file.path}</div>
            <DiffExcerpt file={file} anchorLine={line} context={6} symbols={symbols} onSymbol={onSymbol} fontClass="text-[12.5px]" />
          </>
        ) : (
          <div className="text-ink-4 text-[12px] leading-[1.5]">File not found in this pack.</div>
        )}
      </div>
    </div>
  );
}
