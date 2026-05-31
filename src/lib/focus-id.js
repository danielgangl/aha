// Stable, content-anchored ids for Review Focus items — the single source of
// truth shared by the CLI (bin/aha.mjs, which bakes ids into the pack) and the
// client normalizer (src/app.tsx, a parity fallback for un-normalized data).
// The two MUST agree, so this lives in one place rather than two copies.
//
// The author id always wins. Otherwise the id is derived from the item's
// primary evidence file + a short topic slug, so it tracks the *concern* rather
// than its list position — a positional id would make a reviewer's triage stick
// to a slot instead of a topic after a regeneration (the re-review desync this
// fixes). Plain JS (no types) so node can import it directly, like prompts.js.

export function idSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function stemOfPath(filePath) {
  const base = String(filePath).split("/").pop() || "";
  return base.replace(/\.[^.]+$/, "");
}

// Flatten raw (pre-normalize) rich text — string or array of strings/ref tokens.
export function rawRichToText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : (part && (part.label || part.id)) || "")).join(" ");
  }
  return "";
}

// First few slug tokens of a title/text — the human-readable concern anchor.
export function topicSlug(value) {
  return idSlug(rawRichToText(value)).split("-").filter(Boolean).slice(0, 4).join("-");
}

export function contentAnchoredOverviewId(item, kind) {
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  const anchor = evidence.find((entry) => entry && (entry.path || entry.fileId));
  const fileStem = anchor ? idSlug(stemOfPath(anchor.path || anchor.fileId)) : "";
  const topic = topicSlug(item?.title != null ? item.title : item?.text);
  const parts = [kind, fileStem, topic].filter(Boolean);
  return parts.length > 1 ? parts.join("-") : `${kind}-item`;
}

// Resolve one overview item's id, deduping against ids already used in this pass.
export function overviewItemId(item, kind, used) {
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
