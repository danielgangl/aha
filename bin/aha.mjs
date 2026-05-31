#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  fillAhaWorkflowPrompt,
  AHA_FULL_WORKFLOW_INIT_PROMPT,
  AHA_FULL_WORKFLOW_UPDATE_PROMPT,
} from "../src/prompts.js";
import { overviewItemId } from "../src/lib/focus-id.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const packsRoot = path.resolve(root, process.env.AHA_PACKS_DIR || "packs");
const cliCommand = shellQuote(resolveCliCommand());

// CLI path embedded in prompts/onboarding. Defaults to this running bin, but a
// machine-local override (env var or gitignored file) wins so nobody has to
// commit their personal absolute path.
function resolveCliCommand() {
  const fromEnv = process.env.AHA_CLI && process.env.AHA_CLI.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readLocalCliOverride();
  if (fromFile) return fromFile;
  return fileURLToPath(import.meta.url);
}

function readLocalCliOverride() {
  try {
    const raw = fs.readFileSync(path.join(root, ".aha.local.json"), "utf8");
    const value = JSON.parse(raw)?.cli;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

const command = process.argv[2];
const args = process.argv.slice(3);

class CliError extends Error {}

const GROUPS = [
  { key: "Schema", tests: [/migrations?/i, /(^|\/)schema(\/|$)/i, /schema\.(sql|prisma)$/i, /prisma/i, /drizzle/i], why: "data model and persistence shape" },
  { key: "Permissions", tests: [/auth/i, /permissions?/i, /policy/i, /access/i, /guard/i], why: "authorization and access rules" },
  { key: "Services", tests: [/services?/i, /lib/i, /domain/i], why: "business logic and domain behavior" },
  { key: "API", tests: [/(^|\/)api(\/|$)/i, /route/i, /controller/i, /handler/i], why: "entrypoints and boundaries" },
  { key: "UI", tests: [/components?/i, /(^|\/)app(\/|$)/i, /page/i, /(^|\/)ui(\/|$)/i, /\.tsx$/i, /\.jsx$/i], why: "visible product surface" },
  { key: "Types", tests: [/types?/i, /constants?/i, /schema\.ts$/i, /enum/i], why: "shared type-level changes" },
  { key: "Tests", tests: [/tests?/i, /spec/i, /__tests__/i], why: "evidence" },
  { key: "Other", tests: [], why: "supporting changes" },
];

const SYMBOL_IGNORE = new Set([
  "if", "for", "while", "return", "await", "import", "export", "const", "let", "var",
  "function", "class", "new", "try", "catch", "fetch", "json", "promise", "console",
  "else", "switch", "case", "break", "continue", "throw", "async", "from", "type",
  "interface", "extends", "implements", "this", "super", "true", "false", "null",
  "undefined", "string", "number", "boolean", "object", "array", "void", "props",
  "data", "error", "result", "value", "state", "props", "children",
]);

const SYMBOL_DECLARATIONS = [
  { kind: "function", prefix: "fn", re: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g },
  { kind: "function", prefix: "fn", re: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*=>/g },
  { kind: "function", prefix: "fn", re: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/g },
  { kind: "class", prefix: "class", re: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g },
  { kind: "symbol", prefix: "sym", re: /\b(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/g },
];

const SYMBOL_CALL = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const SYMBOL_LIMIT = 100;
const CALLSITE_LIMIT = 50;
const CALLSITE_CONTEXT_BEFORE = 3;
const CALLSITE_CONTEXT_AFTER = 5;
const REVIEW_SIGNAL_RELEVANCE = new Set(["noise", "normal", "context"]);

if (!command || command === "--help" || command === "-h") {
  printHelp();
  process.exit(command ? 0 : 1);
}

if (!["serve", "start", "review", "generate", "update", "normalize", "merge", "prompt"].includes(command)) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

try {
  if (command === "prompt") {
    console.log(buildWorkflowPrompt(args));
    process.exit(0);
  }

  if (command === "generate") {
    const outputPath = await generateFromPr({
      prNumber: requiredArg(args, "--pr", "generate --pr <number>"),
      outPath: readArg(args, "--out"),
      cwd: process.cwd(),
    });
    console.log(outputPath);
    process.exit(0);
  }

  if (command === "update") {
    const outputPath = await updateFromPr({
      prNumber: requiredArg(args, "--pr", "update --pr <number> --pack <aha.json>"),
      packPath: requiredArg(args, "--pack", "update --pr <number> --pack <aha.json>"),
      outPath: readArg(args, "--out"),
      cwd: process.cwd(),
    });
    console.log(outputPath);
    process.exit(0);
  }

  if (command === "normalize") {
    const outputPath = normalizePackFile({
      packPath: requiredArg(args, "--pack", "normalize --pack <aha.json>"),
      outPath: readArg(args, "--out"),
      cwd: process.cwd(),
    });
    console.log(outputPath);
    process.exit(0);
  }

  if (command === "merge") {
    const outputPath = mergePackFragments({
      packPath: requiredArg(args, "--pack", "merge --pack <aha.json> --fragments <fragment.json,...>"),
      fragmentPaths: readFragmentPaths(args),
      outPath: readArg(args, "--out"),
      cwd: process.cwd(),
    });
    console.log(outputPath);
    process.exit(0);
  }

  const packPath = readArg(args, "--pack");
  const prNumber = readArg(args, "--pr");
  let resolvedPackPath;

  if (packPath) {
    resolvedPackPath = resolveAndValidatePack(packPath);
  } else if (command === "serve" || command === "start") {
    resolvedPackPath = null;
  } else if (command === "review" && prNumber) {
    resolvedPackPath = await generateFromPr({
      prNumber,
      outPath: readArg(args, "--out"),
      cwd: process.cwd(),
    });
  } else {
    const usage = command === "review"
      ? "review --pack <aha.json> or review --pr <number>"
      : "serve [--pack <aha.json>]";
    throw new CliError(`Missing required arguments. Use ${usage}.`);
  }

  await servePack({
    packPath: resolvedPackPath,
    openBrowser: command === "review",
    port: Number(readArg(args, "--port") || process.env.PORT || 4173),
    host: readArg(args, "--host") || "127.0.0.1",
    empty: command === "start",
  });
} catch (error) {
  console.error(error instanceof CliError ? error.message : error.stack || error.message);
  process.exit(1);
}

async function generateFromPr({ prNumber, outPath, cwd }) {
  const pack = await generatePackForPr({ prNumber, cwd });

  const outputPath = outPath
    ? path.resolve(cwd, outPath)
    : defaultPackPathFor(pack);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(pack, null, 2) + "\n");
  JSON.parse(fs.readFileSync(outputPath, "utf8"));
  warnIfOutsidePacks(outputPath);
  return outputPath;
}

function defaultPackPathFor(pack) {
  const repo = slug(pack.repositoryName || pack.repoName || pack.repository?.name || "repo");
  const pr = slug(pack.number || "pr");
  return path.join(packsRoot, repo, pr, `aha-${slug(pack.branch || "branch")}-${pack.number}.json`);
}

// Surface when a pack is written outside the central packs/ library — e.g. an
// agent workflow that resolved a relative --pack against the target repo's cwd
// instead of the aha repo. Informational only; explicit standalone --out paths
// stay allowed.
function warnIfOutsidePacks(outputPath) {
  const resolved = path.resolve(outputPath);
  const rootWithSep = packsRoot.endsWith(path.sep) ? packsRoot : packsRoot + path.sep;
  if (resolved.startsWith(rootWithSep)) return;
  console.error(
    `warning: pack is outside the central aha library (${packsRoot}).\n` +
    `  wrote: ${resolved}\n` +
    `  if this is an agent run, pass an absolute aha-repo pack path so it doesn't land in the target repo.`
  );
}

function buildWorkflowPrompt(argv) {
  const mode = readArg(argv, "--mode") || "init";
  if (!["init", "update"].includes(mode)) {
    throw new CliError("Invalid --mode. Use prompt --mode init or prompt --mode update.");
  }
  const prNumber = readArg(argv, "--pr") || "";
  const targetRepo = readArg(argv, "--repo") || "";
  const packPath = readArg(argv, "--pack") || "/absolute/path/to/aha.json";
  const template = mode === "update"
    ? AHA_FULL_WORKFLOW_UPDATE_PROMPT
    : AHA_FULL_WORKFLOW_INIT_PROMPT;
  return fillAhaWorkflowPrompt(template, {
    cliCommand,
    targetRepo,
    prNumber,
    packPath,
  });
}

async function generatePackForPr({ prNumber, cwd }) {
  await assertGitRepo(cwd);
  await assertGhAvailable();
  await assertGhAuthenticated(cwd);

  const pr = await ghJson([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,title,headRefName,baseRefName,author,url,additions,deletions,changedFiles,createdAt",
  ], cwd);
  const patch = await ghText(["pr", "diff", String(prNumber)], cwd);
  const pack = await buildAha(pr, patch, cwd);
  validateAha(pack);
  return pack;
}

async function updateFromPr({ prNumber, packPath, outPath, cwd }) {
  const existingPackPath = path.resolve(cwd, packPath);
  if (!fs.existsSync(existingPackPath)) {
    throw new CliError(`Pack does not exist: ${existingPackPath}`);
  }
  const existingPack = JSON.parse(fs.readFileSync(existingPackPath, "utf8"));
  const basePack = await generatePackForPr({ prNumber, cwd });
  const updatedPack = mergeExistingEnrichment(basePack, existingPack);
  validateAha(updatedPack);

  const outputPath = outPath ? path.resolve(cwd, outPath) : existingPackPath;
  const report = createUpdateReport(existingPack, updatedPack);
  let backupPath = "";
  if (outputPath === existingPackPath) {
    backupPath = backupPathFor(existingPackPath, "pre-update");
    fs.copyFileSync(existingPackPath, backupPath);
    console.error(`backup: ${backupPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(updatedPack, null, 2) + "\n");
  JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const updateReportPath = reportPathFor(outputPath);
  fs.writeFileSync(updateReportPath, JSON.stringify({
    ...report,
    packPath: outputPath,
    backupPath,
    generatedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  console.error(`report: ${updateReportPath}`);
  warnIfOutsidePacks(outputPath);
  return outputPath;
}

function normalizePackFile({ packPath, outPath, cwd }) {
  const inputPath = path.resolve(cwd, packPath);
  if (!fs.existsSync(inputPath)) {
    throw new CliError(`Pack does not exist: ${inputPath}`);
  }
  const pack = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  normalizePackDeterministicMetadata(pack);
  validateAha(pack);

  const outputPath = outPath ? path.resolve(cwd, outPath) : inputPath;
  if (outputPath === inputPath) {
    const backupPath = backupPathFor(inputPath, "pre-normalize");
    fs.copyFileSync(inputPath, backupPath);
    console.error(`backup: ${backupPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(pack, null, 2) + "\n");
  JSON.parse(fs.readFileSync(outputPath, "utf8"));
  return outputPath;
}

function mergePackFragments({ packPath, fragmentPaths, outPath, cwd }) {
  if (!fragmentPaths.length) {
    throw new CliError("Missing required fragments. Use merge --pack <aha.json> --fragments <fragment.json,...>.");
  }
  const inputPath = path.resolve(cwd, packPath);
  if (!fs.existsSync(inputPath)) {
    throw new CliError(`Pack does not exist: ${inputPath}`);
  }

  const pack = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const beforeDiffs = diffTruthSnapshot(pack);
  for (const fragmentPath of fragmentPaths) {
    const resolvedFragmentPath = path.resolve(cwd, fragmentPath);
    if (!fs.existsSync(resolvedFragmentPath)) {
      throw new CliError(`Fragment does not exist: ${resolvedFragmentPath}`);
    }
    const fragment = JSON.parse(fs.readFileSync(resolvedFragmentPath, "utf8"));
    mergePackFragment(pack, fragment, resolvedFragmentPath);
  }
  assertDiffTruthUnchanged(pack, beforeDiffs);
  normalizePackDeterministicMetadata(pack);
  assertDiffTruthUnchanged(pack, beforeDiffs);
  validateAha(pack);

  const outputPath = outPath ? path.resolve(cwd, outPath) : inputPath;
  if (outputPath === inputPath) {
    const backupPath = backupPathFor(inputPath, "pre-merge");
    fs.copyFileSync(inputPath, backupPath);
    console.error(`backup: ${backupPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(pack, null, 2) + "\n");
  JSON.parse(fs.readFileSync(outputPath, "utf8"));
  return outputPath;
}

function mergePackFragment(pack, fragment, fragmentPath) {
  if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) {
    throw new CliError(`Fragment must be a JSON object: ${fragmentPath}`);
  }
  const fileByPath = new Map((pack.files || []).map((file) => [file.path, file]));
  const fileById = new Map((pack.files || []).map((file) => [file.id, file]));

  if (Array.isArray(fragment.files)) {
    for (const fragmentFile of fragment.files) {
      if (!fragmentFile || typeof fragmentFile !== "object" || Array.isArray(fragmentFile)) continue;
      const fileKey = fragmentFile.path || fragmentFile.id;
      const file = fileByPath.get(fileKey) || fileById.get(fileKey);
      if (!file) throw new CliError(`Fragment ${fragmentPath} references missing file ${fileKey}`);
      if (fragmentFile.note != null) {
        if (typeof fragmentFile.note !== "string") throw new CliError(`Fragment ${fragmentPath} file.note must be a string for ${file.path}`);
        file.note = fragmentFile.note;
      }
      if (fragmentFile.changedNote != null) {
        if (typeof fragmentFile.changedNote !== "string") throw new CliError(`Fragment ${fragmentPath} file.changedNote must be a string for ${file.path}`);
        file.changedNote = fragmentFile.changedNote;
      }
      if (fragmentFile.notes != null) {
        if (!Array.isArray(fragmentFile.notes)) throw new CliError(`Fragment ${fragmentPath} file.notes must be an array for ${file.path}`);
        file.notes = fragmentFile.notes;
      }
    }
  }

  if (fragment.readingOrders !== undefined) {
    if (!Array.isArray(fragment.readingOrders)) throw new CliError(`Fragment ${fragmentPath} readingOrders must be an array`);
    pack.readingOrders = fragment.readingOrders;
  }
  if (fragment.reviewSignals !== undefined) {
    if (!fragment.reviewSignals || typeof fragment.reviewSignals !== "object" || Array.isArray(fragment.reviewSignals)) {
      throw new CliError(`Fragment ${fragmentPath} reviewSignals must be an object`);
    }
    pack.reviewSignals = fragment.reviewSignals;
  }
  if (fragment.overview !== undefined) {
    if (!fragment.overview || typeof fragment.overview !== "object" || Array.isArray(fragment.overview)) {
      throw new CliError(`Fragment ${fragmentPath} overview must be an object`);
    }
    pack.overview = fragment.overview;
  }
  if (fragment.decisions !== undefined) {
    if (!fragment.decisions || typeof fragment.decisions !== "object" || Array.isArray(fragment.decisions)) {
      throw new CliError(`Fragment ${fragmentPath} decisions must be an object`);
    }
    pack.decisions = fragment.decisions;
  }
}

function diffTruthSnapshot(pack) {
  return new Map((pack.files || []).map((file) => [file.path || file.id, {
    path: file.path,
    tag: file.tag,
    add: file.add,
    del: file.del,
    diff: JSON.stringify(file.diff),
  }]));
}

function assertDiffTruthUnchanged(pack, beforeDiffs) {
  for (const file of pack.files || []) {
    const before = beforeDiffs.get(file.path || file.id);
    if (!before) throw new CliError(`Fragment merge added unexpected file ${file.path || file.id}`);
    if (
      file.path !== before.path ||
      file.tag !== before.tag ||
      file.add !== before.add ||
      file.del !== before.del ||
      JSON.stringify(file.diff) !== before.diff
    ) {
      throw new CliError(`Fragment merge attempted to change deterministic diff truth for ${before.path}`);
    }
  }
  if ((pack.files || []).length !== beforeDiffs.size) {
    throw new CliError("Fragment merge attempted to add or remove files");
  }
}

function normalizePackDeterministicMetadata(pack) {
  const fileAliases = canonicalizePackFileIds(pack);
  canonicalizePackFileReferences(pack, fileAliases);
  for (const file of Array.isArray(pack.files) ? pack.files : []) {
    file.diffFingerprint = diffFingerprintForFile(file);
  }
  addAnchorFingerprintsToPack(pack);
}

function canonicalizePackFileIds(pack) {
  const aliases = new Map();
  for (const file of Array.isArray(pack.files) ? pack.files : []) {
    if (!file || typeof file !== "object") continue;
    const oldId = nonEmptyString(file.id);
    const oldPath = nonEmptyString(file.path);
    const canonicalPath = oldPath || oldId;
    if (!canonicalPath) continue;
    if (oldId) aliases.set(oldId, canonicalPath);
    if (oldPath) aliases.set(oldPath, canonicalPath);
    file.path = canonicalPath;
    delete file.id;
  }
  return aliases;
}

function canonicalizePackFileReferences(pack, fileAliases) {
  canonicalizeSymbolFileRefs(pack.symbols, fileAliases);
  canonicalizeReadingOrderFileRefs(pack, fileAliases);
  canonicalizeDecisionFileRefs(pack.decisions, fileAliases);
  canonicalizeOverviewFileRefs(pack.overview, fileAliases);
  canonicalizeReviewSignalsFileRefs(pack.reviewSignals, fileAliases);
}

function canonicalFileId(value, fileAliases) {
  if (typeof value !== "string" || !value) return null;
  return fileAliases.get(value) || null;
}

function canonicalizeSymbolFileRefs(symbols, fileAliases) {
  if (!symbols || typeof symbols !== "object" || Array.isArray(symbols)) return;
  for (const symbol of Object.values(symbols)) {
    if (!symbol || typeof symbol !== "object") continue;
    canonicalizeFileIdField(symbol.defined, fileAliases);
    for (const caller of Array.isArray(symbol.callers) ? symbol.callers : []) {
      canonicalizeFileIdField(caller, fileAliases);
    }
    for (const caller of Array.isArray(symbol.notCallers) ? symbol.notCallers : []) {
      canonicalizeFileIdField(caller, fileAliases);
    }
  }
}

function canonicalizeFileIdField(value, fileAliases) {
  if (!value || typeof value !== "object") return;
  const raw = value.path ?? value.fileId ?? value.file;
  if (raw == null) return;
  const canonical = canonicalFileId(raw, fileAliases);
  if (canonical) value.path = canonical;
  else delete value.path;
  delete value.fileId;
  delete value.file;
}

function canonicalizeReadingOrderFileRefs(pack, fileAliases) {
  if (!Array.isArray(pack.readingOrders)) return;
  for (const order of pack.readingOrders) {
    for (const group of Array.isArray(order?.groups) ? order.groups : []) {
      if (!Array.isArray(group.files)) continue;
      group.files = Array.from(new Set(group.files.map((id) => canonicalFileId(id, fileAliases)).filter(Boolean)));
    }
  }
}

function canonicalizeDecisionFileRefs(decisions, fileAliases) {
  if (!decisions || typeof decisions !== "object") return;
  for (const card of Array.isArray(decisions.cards) ? decisions.cards : []) {
    for (const section of Array.isArray(card?.sections) ? card.sections : []) {
      if (!Array.isArray(section.items)) continue;
      section.items = section.items.map((item) => canonicalizeDecisionFileRef(item, fileAliases)).filter(Boolean);
    }
  }
  for (const question of Array.isArray(decisions.questions) ? decisions.questions : []) {
    if (Array.isArray(question.jumps)) {
      question.jumps = question.jumps.map((jump) => canonicalizeDecisionFileRef(jump, fileAliases)).filter(Boolean);
    }
    if (question.jump) {
      question.jump = canonicalizeDecisionFileRef(question.jump, fileAliases);
      if (!question.jump) delete question.jump;
    }
  }
}

function canonicalizeDecisionFileRef(item, fileAliases) {
  if (!item || typeof item !== "object") return null;
  const raw = item.path ?? item.fileId;
  if (raw == null) return item;
  const canonical = canonicalFileId(raw, fileAliases);
  if (!canonical) return null;
  const next = { ...item, path: canonical };
  delete next.fileId;
  return next;
}

function canonicalizeOverviewFileRefs(overview, fileAliases) {
  if (!overview || typeof overview !== "object") return;
  canonicalizeRichFileRefs(overview.mentalModelDelta, fileAliases);
  if (overview.systemMap && typeof overview.systemMap === "object") {
    for (const line of Array.isArray(overview.systemMap.lines) ? overview.systemMap.lines : []) {
      canonicalizeRichFileRefs(line, fileAliases);
    }
    overview.systemMap.refs = canonicalizeRefList(overview.systemMap.refs, fileAliases);
  }
  for (const item of Array.isArray(overview.modelDeltas) ? overview.modelDeltas : []) {
    if (!item || typeof item !== "object") continue;
    canonicalizeRichFileRefs(item?.title, fileAliases);
    canonicalizeRichFileRefs(item?.before, fileAliases);
    canonicalizeRichFileRefs(item?.after, fileAliases);
    item.refs = canonicalizeRefList(item?.refs, fileAliases);
  }
  for (const flow of Array.isArray(overview.flows) ? overview.flows : []) {
    for (const line of Array.isArray(flow?.lines) ? flow.lines : []) canonicalizeRichFileRefs(line, fileAliases);
    for (const line of Array.isArray(flow?.before) ? flow.before : []) canonicalizeRichFileRefs(line, fileAliases);
    for (const line of Array.isArray(flow?.after) ? flow.after : []) canonicalizeRichFileRefs(line, fileAliases);
  }
  for (const item of Array.isArray(overview.assumptions) ? overview.assumptions : []) {
    if (!item || typeof item !== "object") continue;
    canonicalizeRichFileRefs(item?.text, fileAliases);
    item.refs = canonicalizeRefList(item?.refs, fileAliases);
  }
  for (const item of Array.isArray(overview.hotspots) ? overview.hotspots : []) {
    if (!item || typeof item !== "object") continue;
    canonicalizeRichFileRefs(item?.title, fileAliases);
    canonicalizeRichFileRefs(item?.why, fileAliases);
    item.refs = canonicalizeRefList(item?.refs, fileAliases);
  }
}

function canonicalizeRichFileRefs(value, fileAliases) {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (!part || typeof part !== "object" || part.type !== "file") continue;
    const canonical = canonicalFileId(part.id, fileAliases);
    if (canonical) part.id = canonical;
  }
}

function canonicalizeRefList(refs, fileAliases) {
  if (!Array.isArray(refs)) return [];
  return refs.map((ref) => {
    if (!ref || typeof ref !== "object") return null;
    if (ref.type !== "file") return ref;
    const canonical = canonicalFileId(ref.id, fileAliases);
    return canonical ? { ...ref, id: canonical } : null;
  }).filter(Boolean);
}

function canonicalizeReviewSignalsFileRefs(reviewSignals, fileAliases) {
  if (!reviewSignals || typeof reviewSignals !== "object") return;
  const signals = reviewSignals.files;
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) return;
  const nextFiles = {};
  for (const [fileKey, signal] of Object.entries(signals)) {
    const canonicalKey = canonicalFileId(fileKey, fileAliases);
    if (!canonicalKey || !signal || typeof signal !== "object" || Array.isArray(signal)) continue;
    const nextSignal = nextFiles[canonicalKey]
      ? {
          ...nextFiles[canonicalKey],
          ...signal,
          ranges: [
            ...(Array.isArray(nextFiles[canonicalKey].ranges) ? nextFiles[canonicalKey].ranges : []),
            ...(Array.isArray(signal.ranges) ? signal.ranges : []),
          ],
        }
      : { ...signal };
    nextSignal.ranges = (Array.isArray(nextSignal.ranges) ? nextSignal.ranges : [])
      .map((range) => canonicalizeSignalRangeFileRefs(range, canonicalKey, fileAliases));
    nextFiles[canonicalKey] = nextSignal;
  }
  reviewSignals.files = nextFiles;
}

function canonicalizeSignalRangeFileRefs(range, ownerPath, fileAliases) {
  if (!range || typeof range !== "object") return range;
  const anchor = range.anchor && typeof range.anchor === "object" ? { ...range.anchor } : {};
  for (const side of ["left", "right"]) {
    if (!anchor[side] || typeof anchor[side] !== "object") continue;
    const sideAnchor = { ...anchor[side] };
    if (sideAnchor.path) {
      const canonical = canonicalFileId(sideAnchor.path, fileAliases);
      if (canonical && canonical !== ownerPath) sideAnchor.path = canonical;
      else delete sideAnchor.path;
    }
    anchor[side] = sideAnchor;
  }
  return { ...range, anchor };
}

function nonEmptyString(value) {
  return typeof value === "string" && value ? value : "";
}

function createUpdateReport(oldPack, newPack) {
  const oldFiles = new Map((oldPack.files || []).map((file) => [file.path || file.id, file]));
  const newFiles = new Map((newPack.files || []).map((file) => [file.path || file.id, file]));
  const addedFiles = [];
  const removedFiles = [];
  const changedFiles = [];
  const unchangedFiles = [];

  for (const [filePath, file] of newFiles) {
    const oldFile = oldFiles.get(filePath);
    if (!oldFile) {
      addedFiles.push(filePath);
    } else if (oldFile.diffFingerprint === file.diffFingerprint) {
      unchangedFiles.push(filePath);
    } else {
      changedFiles.push(filePath);
    }
  }
  for (const filePath of oldFiles.keys()) {
    if (!newFiles.has(filePath)) removedFiles.push(filePath);
  }

  const notes = compareInlineNotes(oldPack, newPack);
  const reviewSignals = compareReviewSignalRanges(oldPack, newPack);
  return {
    schemaVersion: "0.1",
    kind: "aha-update-report",
    pr: {
      number: newPack.number,
      title: newPack.title,
      branch: newPack.branch,
      base: newPack.base,
      url: newPack.url || "",
    },
    files: {
      added: addedFiles,
      removed: removedFiles,
      changed: changedFiles,
      unchanged: unchangedFiles,
    },
    enrichment: {
      inlineNotes: notes,
      reviewSignals,
      fileNotes: compareFileNotes(oldPack, newPack),
      overviewPresent: !!newPack.overview,
      decisionCards: newPack.decisions?.cards?.length || 0,
      readingOrders: newPack.readingOrders?.length || 0,
    },
  };
}

function compareFileNotes(oldPack, newPack) {
  const oldFiles = new Map((oldPack.files || []).map((file) => [file.path || file.id, file]));
  const newFiles = new Map((newPack.files || []).map((file) => [file.path || file.id, file]));
  const dropped = [];
  let preserved = 0;
  for (const [filePath, oldFile] of oldFiles) {
    if (!oldFile.note) continue;
    const newFile = newFiles.get(filePath);
    if (newFile?.note === oldFile.note) preserved += 1;
    else dropped.push({ file: filePath, note: oldFile.note });
  }
  return { preserved, dropped };
}

function compareInlineNotes(oldPack, newPack) {
  const oldByFile = new Map((oldPack.files || []).map((file) => [file.path || file.id, file]));
  const newByFile = new Map((newPack.files || []).map((file) => [file.path || file.id, file]));
  const dropped = [];
  const moved = [];
  let preserved = 0;
  let oldTotal = 0;
  let newTotal = 0;
  for (const [filePath, oldFile] of oldByFile) {
    const oldNotes = Array.isArray(oldFile.notes) ? oldFile.notes : [];
    const newNotes = Array.isArray(newByFile.get(filePath)?.notes) ? newByFile.get(filePath).notes : [];
    oldTotal += oldNotes.length;
    newTotal += newNotes.length;
    const newKeys = new Map(newNotes.map((note) => [inlineNoteStableKey(note), note]));
    for (const oldNote of oldNotes) {
      const next = newKeys.get(inlineNoteStableKey(oldNote));
      if (!next) {
        dropped.push({
          file: filePath,
          side: oldNote.afterR != null ? "right" : "left",
          line: oldNote.afterR ?? oldNote.afterL ?? null,
          src: oldNote.src || "",
          html: oldNote.html || "",
          htmlPreview: shortText(oldNote.html || ""),
        });
        continue;
      }
      preserved += 1;
      const oldLine = oldNote.afterR ?? oldNote.afterL ?? null;
      const nextLine = next.afterR ?? next.afterL ?? null;
      if (oldLine !== nextLine) {
        moved.push({
          file: filePath,
          from: oldLine,
          to: nextLine,
          src: next.src || "",
          html: next.html || "",
          htmlPreview: shortText(next.html || ""),
        });
      }
    }
  }
  return { oldTotal, newTotal, preserved, dropped, moved };
}

function inlineNoteStableKey(note) {
  return hashString(`${note?.src || ""}\n${note?.html || ""}`);
}

function compareReviewSignalRanges(oldPack, newPack) {
  const oldSignals = oldPack.reviewSignals?.files || {};
  const newSignals = newPack.reviewSignals?.files || {};
  const dropped = [];
  const moved = [];
  let oldTotal = 0;
  let newTotal = 0;
  let preserved = 0;
  for (const [filePath, oldSignal] of Object.entries(oldSignals)) {
    const oldRanges = Array.isArray(oldSignal?.ranges) ? oldSignal.ranges : [];
    const newRanges = Array.isArray(newSignals[filePath]?.ranges) ? newSignals[filePath].ranges : [];
    oldTotal += oldRanges.length;
    newTotal += newRanges.length;
    const newById = new Map(newRanges.map((range) => [range.id, range]));
    for (const oldRange of oldRanges) {
      const next = newById.get(oldRange.id);
      if (!next) {
        dropped.push({
          file: filePath,
          id: oldRange.id || "",
          kind: oldRange.kind || "",
          reason: oldRange.reason || "",
          reasonPreview: shortText(oldRange.reason || ""),
          range: oldRange,
        });
        continue;
      }
      preserved += 1;
      const oldRangeLabel = rangeAnchorLabel(oldRange.anchor);
      const nextRangeLabel = rangeAnchorLabel(next.anchor);
      if (oldRangeLabel !== nextRangeLabel) {
        moved.push({
          file: filePath,
          id: next.id || "",
          kind: next.kind || "",
          from: oldRangeLabel,
          to: nextRangeLabel,
        });
      }
    }
  }
  return { oldTotal, newTotal, preserved, dropped, moved };
}

function rangeAnchorLabel(anchor) {
  const left = anchor?.left ? `L${anchor.left.path ? `${anchor.left.path}:` : ""}${anchor.left.start}-${anchor.left.end ?? anchor.left.start}` : "";
  const right = anchor?.right ? `R${anchor.right.path ? `${anchor.right.path}:` : ""}${anchor.right.start}-${anchor.right.end ?? anchor.right.start}` : "";
  return [left, right].filter(Boolean).join(" ");
}

function shortText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

async function buildAha(pr, patch, cwd) {
  const files = parseGitPatch(patch);
  const symbols = await buildSymbols(files, cwd);
  annotateDiffSymbols(files, symbols);
  for (const file of files) {
    file.diffFingerprint = diffFingerprintForFile(file);
  }
  const groups = groupsFor(files);
  const added = files.reduce((sum, file) => sum + file.add, 0);
  const removed = files.reduce((sum, file) => sum + file.del, 0);
  return {
    schemaVersion: "0.1",
    repositoryName: await repositoryNameForCwd(cwd),
    number: pr.number,
    title: pr.title || `PR #${pr.number}`,
    oneLiner: pr.url ? `${pr.title || `PR #${pr.number}`} · ${pr.url}` : pr.title || `PR #${pr.number}`,
    url: pr.url || "",
    branch: pr.headRefName || "",
    base: pr.baseRefName || "",
    author: authorFrom(pr.author),
    opened: pr.createdAt || "",
    filesChanged: files.length,
    added,
    removed,
    files,
    symbols,
    groups,
    readingOrders: [],
    decisions: {
      categories: [],
      cards: [],
      questions: [],
    },
  };
}

function mergeExistingEnrichment(basePack, existingPack) {
  const pack = JSON.parse(JSON.stringify(basePack));
  const baseFilesByPath = new Map(pack.files.map((file) => [file.path, file]));
  const oldFilesByPath = new Map((existingPack.files || []).map((file) => [file.path || file.id, file]));
  const filePaths = new Set(pack.files.map((file) => file.path));
  const symbolIds = new Set(Object.keys(pack.symbols || {}));

  for (const file of pack.files) {
    const oldFile = oldFilesByPath.get(file.path);
    if (!oldFile) continue;
    if (oldFile.diffFingerprint === file.diffFingerprint && typeof oldFile.note === "string") {
      file.note = oldFile.note;
    }
    if (oldFile.diffFingerprint === file.diffFingerprint && typeof oldFile.changedNote === "string") {
      file.changedNote = oldFile.changedNote;
    }
    file.notes = preserveInlineNotes(oldFile.notes, oldFile, file);
  }

  preserveSymbolSummaries(pack.symbols, existingPack.symbols);
  pack.readingOrders = preserveReadingOrders(existingPack.readingOrders, filePaths);
  pack.decisions = preserveDecisions(existingPack.decisions, filePaths);
  const decisionIds = new Set((pack.decisions.cards || []).map((card) => card.id).filter(Boolean));
  pack.overview = preserveOverview(existingPack.overview, { filePaths, symbolIds, decisionIds });
  pack.reviewSignals = preserveReviewSignals(existingPack.reviewSignals, baseFilesByPath, oldFilesByPath);
  addAnchorFingerprintsToPack(pack);
  return pack;
}

function preserveInlineNotes(notes, oldFile, newFile) {
  if (!Array.isArray(notes)) return [];
  return notes
    .map((note) => preserveInlineNote(note, oldFile, newFile))
    .filter(Boolean);
}

function preserveInlineNote(note, oldFile, newFile) {
  if (!note || typeof note !== "object") return null;
  const oldAnchor = noteAnchorFromNote(note, oldFile);
  if (!oldAnchor) return null;
  const nextAnchor = findMatchingSideAnchor(oldAnchor, newFile, oldAnchor.side);
  if (!nextAnchor) return null;
  const next = { ...note, anchor: inlineAnchorMetadata(nextAnchor, oldAnchor.side) };
  if (oldAnchor.side === "right") {
    next.afterR = nextAnchor.start;
    delete next.afterL;
  } else {
    next.afterL = nextAnchor.start;
    delete next.afterR;
  }
  return next;
}

function noteAnchorFromNote(note, file) {
  if (!file) return null;
  if (Number.isFinite(Number(note.afterR))) {
    const line = Number(note.afterR);
    const existing = note.anchor?.side === "right" && note.anchor?.textFingerprint
      ? { start: line, end: line, textFingerprint: note.anchor.textFingerprint, text: note.anchor.text }
      : sideAnchorWithFingerprint(file, { start: line, end: line }, "right");
    return existing ? { ...existing, side: "right" } : null;
  }
  if (Number.isFinite(Number(note.afterL))) {
    const line = Number(note.afterL);
    const existing = note.anchor?.side === "left" && note.anchor?.textFingerprint
      ? { start: line, end: line, textFingerprint: note.anchor.textFingerprint, text: note.anchor.text }
      : sideAnchorWithFingerprint(file, { start: line, end: line }, "left");
    return existing ? { ...existing, side: "left" } : null;
  }
  return null;
}

function inlineAnchorMetadata(anchor, side) {
  return {
    side,
    line: anchor.start,
    textFingerprint: anchor.textFingerprint,
    text: anchor.text,
  };
}

function preserveSymbolSummaries(baseSymbols = {}, oldSymbols = {}) {
  if (!oldSymbols || typeof oldSymbols !== "object") return;
  for (const [id, symbol] of Object.entries(baseSymbols)) {
    const old = oldSymbols[id];
    if (!old || typeof old !== "object") continue;
    if (!symbol.summary && typeof old.summary === "string") symbol.summary = old.summary;
  }
}

function preserveReadingOrders(readingOrders, filePaths) {
  if (!Array.isArray(readingOrders)) return [];
  return readingOrders
    .map((order, orderIndex) => ({
      key: typeof order?.key === "string" && order.key ? order.key : `reading-order-${orderIndex + 1}`,
      label: typeof order?.label === "string" ? order.label : "AI reading order",
      why: typeof order?.why === "string" ? order.why : "",
      groups: (Array.isArray(order?.groups) ? order.groups : [])
        .map((group, groupIndex) => ({
          key: typeof group?.key === "string" && group.key ? group.key : `group-${groupIndex + 1}`,
          label: typeof group?.label === "string" ? group.label : `Step ${groupIndex + 1}`,
          why: typeof group?.why === "string" ? group.why : "",
          files: Array.isArray(group?.files)
            ? Array.from(new Set(group.files.filter((filePath) => filePaths.has(filePath))))
            : [],
        }))
        .filter((group) => group.files.length > 0),
    }))
    .filter((order) => order.groups.length > 0);
}

function preserveDecisions(decisions, filePaths) {
  if (!decisions || typeof decisions !== "object") {
    return { categories: [], cards: [], questions: [] };
  }
  return {
    categories: Array.isArray(decisions.categories) ? decisions.categories : [],
    cards: (Array.isArray(decisions.cards) ? decisions.cards : [])
      .filter((card) => card && typeof card === "object" && typeof card.id === "string")
      .map((card) => ({
        ...card,
        sections: preserveDecisionSections(card.sections, filePaths),
      })),
    questions: (Array.isArray(decisions.questions) ? decisions.questions : [])
      .filter((question) => question && typeof question === "object")
      .map((question) => ({
        ...question,
        jumps: preserveDecisionJumps(question.jumps, filePaths),
      })),
  };
}

function preserveDecisionSections(sections, filePaths) {
  if (!Array.isArray(sections)) return [];
  return sections.map((section) => {
    if (!section || typeof section !== "object") return section;
    return {
      ...section,
      items: Array.isArray(section.items)
        ? section.items.filter((item) => decisionItemRefValid(item, filePaths))
        : section.items,
    };
  });
}

function preserveDecisionJumps(jumps, filePaths) {
  if (!Array.isArray(jumps)) return [];
  return jumps.filter((jump) => decisionItemRefValid(jump, filePaths));
}

function decisionItemRefValid(item, filePaths) {
  if (!item || typeof item !== "object") return false;
  const filePath = item.path ?? item.fileId;
  if (filePath == null) return true;
  return filePaths.has(filePath);
}

function preserveOverview(overview, refs) {
  if (!overview || typeof overview !== "object") return null;
  const usedIds = new Set();
  return {
    mentalModelDelta: preserveRichText(overview.mentalModelDelta, refs),
    systemMap: preserveSystemMap(overview.systemMap, refs),
    modelDeltas: (Array.isArray(overview.modelDeltas) ? overview.modelDeltas : [])
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        ...item,
        id: overviewItemId(item, "model-delta", usedIds),
        title: preserveRichText(item.title, refs),
        before: preserveRichText(item.before, refs),
        after: preserveRichText(item.after, refs),
        refs: preserveRefs(item.refs, refs),
      })),
    flows: (Array.isArray(overview.flows) ? overview.flows : [])
      .filter((flow) => flow && typeof flow === "object")
      .map((flow) => ({
        title: typeof flow.title === "string" ? flow.title : "",
        kind: typeof flow.kind === "string" ? flow.kind : "before_after_ascii",
        lines: preserveRichLines(flow.lines, refs),
        before: preserveRichLines(flow.before, refs),
        after: preserveRichLines(flow.after, refs),
      })),
    assumptions: (Array.isArray(overview.assumptions) ? overview.assumptions : [])
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        ...item,
        id: overviewItemId(item, "assumption", usedIds),
        text: preserveRichText(item.text, refs),
        refs: preserveRefs(item.refs, refs),
      })),
    hotspots: (Array.isArray(overview.hotspots) ? overview.hotspots : [])
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        ...item,
        id: overviewItemId(item, "hotspot", usedIds),
        title: preserveRichText(item.title, refs),
        why: preserveRichText(item.why, refs),
        refs: preserveRefs(item.refs, refs),
      })),
  };
}

function preserveSystemMap(systemMap, refs) {
  if (!systemMap || typeof systemMap !== "object" || Array.isArray(systemMap)) return null;
  return {
    title: typeof systemMap.title === "string" ? systemMap.title : "Affected system",
    kind: typeof systemMap.kind === "string" ? systemMap.kind : "ascii",
    lines: preserveRichLines(systemMap.lines, refs),
    refs: preserveRefs(systemMap.refs, refs),
  };
}

function preserveRichLines(lines, refs) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => preserveRichText(line, refs)).filter((line) => line !== "");
}

function preserveRichText(value, refs) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    return refValid(part, refs) ? part : null;
  }).filter((part) => part !== null);
}

function preserveRefs(value, refs) {
  if (!Array.isArray(value)) return [];
  return value.filter((ref) => refValid(ref, refs));
}

function refValid(ref, { filePaths, symbolIds, decisionIds }) {
  if (!ref || typeof ref !== "object" || typeof ref.id !== "string") return false;
  if (ref.type === "file") return filePaths.has(ref.id);
  if (ref.type === "symbol") return symbolIds.has(ref.id);
  if (ref.type === "decision") return decisionIds.has(ref.id);
  return false;
}

function preserveReviewSignals(reviewSignals, baseFilesByPath, oldFilesByPath = new Map()) {
  if (!reviewSignals || typeof reviewSignals !== "object") return undefined;
  const patterns = preserveSignalPatterns(reviewSignals.patterns);
  const patternIds = new Set(Object.keys(patterns));
  const files = {};
  const inputFiles = reviewSignals.files && typeof reviewSignals.files === "object" ? reviewSignals.files : {};
  for (const [fileKey, signal] of Object.entries(inputFiles)) {
    const file = baseFilesByPath.get(fileKey);
    const oldFile = oldFilesByPath.get(fileKey);
    if (!file || !signal || typeof signal !== "object") continue;
    const rangesInput = Array.isArray(signal.ranges) ? signal.ranges : [];
    const ranges = preserveSignalRanges(signal.ranges, file, baseFilesByPath, oldFilesByPath, patternIds);
    const sameFingerprint = oldFile?.diffFingerprint && oldFile.diffFingerprint === file.diffFingerprint;
    const fileLevelOnly = rangesInput.length === 0;
    if (fileLevelOnly && !sameFingerprint) continue;
    const preserved = {
      relevance: REVIEW_SIGNAL_RELEVANCE.has(signal.relevance) ? signal.relevance : "normal",
      source: ["ai", "deterministic", "manual"].includes(signal.source) ? signal.source : "ai",
      hideByDefault: signal.hideByDefault !== false,
      categories: Array.isArray(signal.categories) ? signal.categories.filter(Boolean) : [],
      reason: typeof signal.reason === "string" ? signal.reason : "",
      ranges,
    };
    files[file.path] = preserved;
  }
  if (Object.keys(files).length === 0 && Object.keys(patterns).length === 0) return undefined;
  return { version: 1, patterns, files };
}

function preserveSignalPatterns(patterns) {
  if (!patterns || typeof patterns !== "object" || Array.isArray(patterns)) return {};
  const preserved = {};
  for (const [id, pattern] of Object.entries(patterns)) {
    if (!pattern || typeof pattern !== "object" || typeof pattern.label !== "string" || !pattern.label.trim()) continue;
    preserved[id] = {
      id,
      label: pattern.label,
      source: ["user", "ai"].includes(pattern.source) ? pattern.source : "ai",
      description: typeof pattern.description === "string" ? pattern.description : "",
    };
  }
  return preserved;
}

function preserveSignalRanges(ranges, ownerFile, baseFilesByPath, oldFilesByPath, patternIds) {
  if (!Array.isArray(ranges)) return [];
  return ranges.map((range) => {
    if (!range || typeof range !== "object") return false;
    if (range.patternId != null && !patternIds.has(range.patternId)) return false;
    const left = range.anchor?.left;
    const right = range.anchor?.right;
    if (!left && !right) return false;
    const nextLeft = left ? preserveSignalSideAnchor(left, "left", ownerFile, baseFilesByPath, oldFilesByPath) : null;
    const nextRight = right ? preserveSignalSideAnchor(right, "right", ownerFile, baseFilesByPath, oldFilesByPath) : null;
    if ((left && !nextLeft) || (right && !nextRight)) return null;
    return {
      ...range,
      anchor: {
        ...(nextLeft ? { left: nextLeft } : {}),
        ...(nextRight ? { right: nextRight } : {}),
      },
    };
  }).filter(Boolean);
}

function preserveSignalSideAnchor(anchor, sideName, ownerFile, baseFilesByPath, oldFilesByPath) {
  const side = sideName === "left" ? "L" : "R";
  const path = typeof anchor.path === "string" && anchor.path ? anchor.path : ownerFile.path;
  const oldFile = oldFilesByPath.get(path);
  const newFile = baseFilesByPath.get(path);
  if (!newFile) return null;
  const oldAnchor = anchor.textFingerprint
    ? normalizeSideAnchorForMatch(anchor)
    : sideAnchorWithFingerprint(oldFile, anchor, sideName);
  if (!oldAnchor) return null;
  const nextAnchor = findMatchingSideAnchor(oldAnchor, newFile, sideName);
  if (!nextAnchor) return null;
  return {
    ...(path !== ownerFile.path ? { path } : {}),
    start: nextAnchor.start,
    end: nextAnchor.end,
    textFingerprint: nextAnchor.textFingerprint,
    text: nextAnchor.text,
  };
}

function normalizeSideAnchorForMatch(anchor) {
  const start = Number(anchor.start);
  const end = Number(anchor.end ?? anchor.start);
  if (!Number.isFinite(start) || !Number.isFinite(end) || typeof anchor.textFingerprint !== "string") return null;
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
    textFingerprint: anchor.textFingerprint,
    text: typeof anchor.text === "string" ? anchor.text : "",
  };
}

function findMatchingSideAnchor(oldAnchor, newFile, sideName) {
  const side = sideName === "left" ? "L" : "R";
  const exact = sideAnchorWithFingerprint(newFile, oldAnchor, sideName);
  if (exact && exact.textFingerprint === oldAnchor.textFingerprint) return exact;

  const matches = matchingSideAnchorsByFingerprint(newFile, side, oldAnchor.textFingerprint, sideAnchorLineCount(oldAnchor));
  if (matches.length === 1) return matches[0];
  return null;
}

function sideAnchorWithFingerprint(file, anchor, sideName) {
  if (!file) return null;
  const side = sideName === "left" ? "L" : sideName === "right" ? "R" : sideName;
  const start = Number(anchor?.start);
  const end = Number(anchor?.end ?? anchor?.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  const lines = sideLinesInRange(file, side, min, max);
  if (lines.length === 0) return null;
  const fingerprint = anchorFingerprintForSideLines(side, lines);
  return {
    start: lines[0][side],
    end: lines.at(-1)[side],
    textFingerprint: fingerprint,
    text: anchorTextForSideLines(lines),
  };
}

function sideLinesInRange(file, side, start, end) {
  return (Array.isArray(file?.diff) ? file.diff : [])
    .filter((line) => line[side] != null && line[side] >= start && line[side] <= end);
}

function sideAnchorLineCount(anchor) {
  const start = Number(anchor.start);
  const end = Number(anchor.end ?? anchor.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.abs(end - start) + 1);
}

function matchingSideAnchorsByFingerprint(file, side, textFingerprint, lineCount) {
  const sideLines = (Array.isArray(file?.diff) ? file.diff : [])
    .filter((line) => line[side] != null);
  const matches = [];
  for (let index = 0; index <= sideLines.length - lineCount; index += 1) {
    const window = sideLines.slice(index, index + lineCount);
    if (anchorFingerprintForSideLines(side, window) !== textFingerprint) continue;
    matches.push({
      start: window[0][side],
      end: window.at(-1)[side],
      textFingerprint,
      text: anchorTextForSideLines(window),
    });
  }
  return matches;
}

function anchorFingerprintForSideLines(side, lines) {
  const text = lines.map((line) => plainDiffContent(line.c)).join("\n");
  return `af1-${hashString(`${side}\n${lines.length}\n${text}`)}`;
}

function anchorTextForSideLines(lines) {
  return lines.map((line) => plainDiffContent(line.c)).join("\n").slice(0, 500);
}

function addAnchorFingerprintsToPack(pack) {
  const filesByPath = new Map((pack.files || []).map((file) => [file.path, file]));
  for (const file of pack.files || []) {
    file.notes = (Array.isArray(file.notes) ? file.notes : [])
      .map((note) => note && typeof note === "object" ? addInlineNoteAnchor(note, file) : note);
  }
  const reviewSignalFiles = pack.reviewSignals?.files;
  if (reviewSignalFiles && typeof reviewSignalFiles === "object") {
    for (const [filePath, signal] of Object.entries(reviewSignalFiles)) {
      const ownerFile = filesByPath.get(filePath);
      if (!ownerFile || !Array.isArray(signal?.ranges)) continue;
      signal.ranges = signal.ranges.map((range) => addRangeAnchorFingerprints(range, ownerFile, filesByPath));
    }
  }
}

function addInlineNoteAnchor(note, file) {
  const anchor = noteAnchorFromNote(note, file);
  return anchor ? { ...note, anchor: inlineAnchorMetadata(anchor, anchor.side) } : note;
}

function addRangeAnchorFingerprints(range, ownerFile, filesByPath) {
  if (!range || typeof range !== "object") return range;
  const left = range.anchor?.left
    ? addSideAnchorFingerprint(range.anchor.left, "left", ownerFile, filesByPath)
    : null;
  const right = range.anchor?.right
    ? addSideAnchorFingerprint(range.anchor.right, "right", ownerFile, filesByPath)
    : null;
  return {
    ...range,
    anchor: {
      ...(left ? { left } : {}),
      ...(right ? { right } : {}),
    },
  };
}

function addSideAnchorFingerprint(anchor, sideName, ownerFile, filesByPath) {
  if (!anchor || typeof anchor !== "object") return null;
  const file = typeof anchor.path === "string" && anchor.path
    ? filesByPath.get(anchor.path)
    : ownerFile;
  const withFingerprint = sideAnchorWithFingerprint(file, anchor, sideName);
  if (!withFingerprint) return anchor;
  return {
    ...anchor,
    start: withFingerprint.start,
    end: withFingerprint.end,
    textFingerprint: withFingerprint.textFingerprint,
    text: withFingerprint.text,
  };
}

function parseGitPatch(patch) {
  const files = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(finalizeFile(current, files.length + 1));
      const parsed = parseDiffGitLine(line);
      current = createFile(parsed.newPath || parsed.oldPath || `file-${files.length + 1}`);
      inHunk = false;
      oldLine = 0;
      newLine = 0;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode ")) {
      current.tag = "new";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.tag = "deleted";
      continue;
    }
    if (line.startsWith("--- ")) {
      const oldPath = parsePatchPath(line.slice(4));
      if (oldPath !== null) current.oldPath = oldPath;
      if (oldPath === null) current.tag = "new";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = parsePatchPath(line.slice(4));
      if (newPath !== null) current.path = newPath;
      if (newPath === null) current.tag = "deleted";
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.diff.push({ k: "hunk", c: line });
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("+")) {
      current.diff.push({ k: "add", R: newLine, c: line.slice(1) });
      current.add += 1;
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.diff.push({ k: "del", L: oldLine, c: line.slice(1) });
      current.del += 1;
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      current.diff.push({ k: "ctx", L: oldLine, R: newLine, c: line.slice(1) });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      continue;
    }
  }

  if (current) files.push(finalizeFile(current, files.length + 1));
  return mergeDuplicateFiles(files);
}

function mergeDuplicateFiles(files) {
  const merged = [];
  const byPath = new Map();

  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, file);
      merged.push(file);
      continue;
    }

    existing.add += file.add;
    existing.del += file.del;
    existing.diff.push(...file.diff);
    existing.notes.push(...(file.notes || []));
    if (existing.tag !== file.tag) {
      existing.tag = existing.tag === "new" || file.tag === "new" ? "new" : "modified";
    }
  }

  return merged.map((file, index) => ({
    ...file,
    path: file.path || `file-${index + 1}`,
    diffFingerprint: diffFingerprintForFile(file),
  }));
}

async function buildSymbols(files, cwd) {
  const candidates = extractSymbolCandidates(files);
  if (candidates.length === 0) return {};

  const rgAvailable = await hasRg();
  if (!rgAvailable) {
    console.warn("warning: rg is missing; keeping declared diff symbols without callsites.");
  }

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const symbols = {};

  for (const candidate of candidates) {
    let matches = [];
    if (rgAvailable) {
      try {
        matches = await searchSymbol(candidate.name, cwd);
      } catch (error) {
        console.warn(`warning: symbol search failed for ${candidate.name}; keeping diff definition only. ${error.message}`);
      }
    }

    if (matches.length === 0 && !candidate.definition) continue;
    const definition = findBestDefinition(candidate, matches, fileByPath) || candidate.definition;
    const fileLineCache = new Map();
    const callers = matches.slice(0, CALLSITE_LIMIT).map((match) => {
      const touchedFile = fileByPath.get(match.path);
      return {
        path: match.path,
        line: match.line,
        inPR: !!touchedFile,
        status: statusForCallsite(match.path, touchedFile),
        context: callsiteContextFor(cwd, match, fileLineCache),
        role: roleForLine(match.text, candidate.name),
      };
    });

    symbols[candidate.id] = {
      id: candidate.id,
      name: candidate.name,
      kind: candidate.kind,
      signature: definition?.text?.trim() || candidate.name,
      defined: {
        path: definition?.path || callers[0]?.path || "",
        line: definition?.line || callers[0]?.line || 1,
      },
      summary: "",
      callers,
      notCallers: [],
    };
  }

  return symbols;
}

function extractSymbolCandidates(files) {
  const candidates = new Map();

  for (const file of files) {
    if (!isCodeLikePath(file.path)) continue;
    for (const line of file.diff) {
      if (!["add", "ctx"].includes(line.k) || typeof line.c !== "string") continue;
      for (const match of extractLineCandidates(line.c)) {
        const definition = match.declared ? {
          path: file.path,
          line: line.R ?? line.L ?? 1,
          text: line.c,
        } : null;
        const existing = candidates.get(match.name);
        if (existing) {
          existing.count += 1;
          if (match.declared && !existing.declared) {
            existing.kind = match.kind;
            existing.prefix = match.prefix;
            existing.declared = true;
            existing.definition = definition;
          } else if (definition && !existing.definition) {
            existing.definition = definition;
          }
        } else {
          candidates.set(match.name, {
            ...match,
            id: symbolId(match.prefix, match.name),
            count: 1,
            definition,
          });
        }
      }
    }
  }

  const sorted = Array.from(candidates.values())
    .filter((candidate) => isGoodSymbolName(candidate.name))
    .sort((a, b) => {
      if (a.declared !== b.declared) return a.declared ? -1 : 1;
      return b.count - a.count || a.name.localeCompare(b.name);
    });
  const declared = sorted.filter((candidate) => candidate.declared);
  const inferred = sorted.filter((candidate) => !candidate.declared);
  return [
    ...declared,
    ...inferred.slice(0, Math.max(0, SYMBOL_LIMIT - declared.length)),
  ];
}

function extractLineCandidates(line) {
  const candidates = [];
  const code = stripTrailingComment(line);

  for (const declaration of SYMBOL_DECLARATIONS) {
    declaration.re.lastIndex = 0;
    let match;
    while ((match = declaration.re.exec(code))) {
      candidates.push({
        name: match[1],
        kind: declaration.kind,
        prefix: declaration.prefix,
        declared: true,
      });
    }
  }

  SYMBOL_CALL.lastIndex = 0;
  let call;
  while ((call = SYMBOL_CALL.exec(code))) {
    candidates.push({
      name: call[1],
      kind: "function",
      prefix: "fn",
      declared: false,
    });
  }

  return candidates;
}

async function hasRg() {
  try {
    await execFileAsync("rg", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function searchSymbol(name, cwd) {
  const args = [
    "--json",
    "--line-number",
    "--hidden",
    "--glob", "!.git/**",
    "--glob", "!node_modules/**",
    "--glob", "!dist/**",
    "--glob", "!build/**",
    "--glob", "!.next/**",
    "--glob", "!coverage/**",
    "--glob", "!.aha/**",
    "--glob", "!*.state.json",
    "--glob", "*.{js,jsx,ts,tsx,mjs,cjs}",
    escapeRegExpWord(name),
    ".",
  ];

  try {
    const { stdout } = await execFileAsync("rg", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return parseRgJson(stdout, name);
  } catch (error) {
    if (error.code === 1) return [];
    if (error.code === "ENOENT") throw new Error("rg is missing");
    const stderr = String(error.stderr || error.message || "").trim();
    throw new Error(stderr || "rg failed");
  }
}

function parseRgJson(output, name) {
  const matches = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const pathText = event.data?.path?.text;
    const lineText = event.data?.lines?.text;
    const lineNumber = event.data?.line_number;
    if (!pathText || !lineText || !lineNumber) continue;
    if (isLikelyVendorPath(pathText)) continue;
    matches.push({
      path: normalizeRepoPath(pathText),
      line: lineNumber,
      text: lineText.replace(/\r?\n$/, ""),
      name,
    });
  }
  return matches;
}

function callsiteContextFor(cwd, match, fileLineCache) {
  const lines = repoFileLines(cwd, match.path, fileLineCache);
  if (!lines) {
    return {
      start: match.line,
      end: match.line,
      lines: [{ line: match.line, c: match.text.trimEnd() }],
    };
  }
  const start = Math.max(1, match.line - CALLSITE_CONTEXT_BEFORE);
  const end = Math.min(lines.length, match.line + CALLSITE_CONTEXT_AFTER);
  const contextLines = [];
  for (let line = start; line <= end; line += 1) {
    contextLines.push({ line, c: lines[line - 1] ?? "" });
  }
  return { start, end, lines: contextLines };
}

function repoFileLines(cwd, repoPath, fileLineCache) {
  if (fileLineCache.has(repoPath)) return fileLineCache.get(repoPath);
  const absolutePath = path.resolve(cwd, repoPath);
  const absoluteCwd = path.resolve(cwd);
  if (!absolutePath.startsWith(`${absoluteCwd}${path.sep}`)) {
    fileLineCache.set(repoPath, null);
    return null;
  }
  try {
    const text = fs.readFileSync(absolutePath, "utf8");
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    fileLineCache.set(repoPath, lines);
    return lines;
  } catch {
    fileLineCache.set(repoPath, null);
    return null;
  }
}

function findBestDefinition(candidate, matches, fileByPath) {
  const declarationMatches = matches.filter((match) => isDeclarationLine(match.text, candidate.name));
  const touchedDeclaration = declarationMatches.find((match) => fileByPath.has(match.path));
  return touchedDeclaration || declarationMatches[0] || matches.find((match) => fileByPath.has(match.path)) || matches[0];
}

function isDeclarationLine(line, name) {
  return declarationRegexFor(name).some((re) => re.test(line));
}

function declarationRegexFor(name) {
  const escaped = escapeRegExp(name);
  return [
    new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
    new RegExp(`\\b(?:export\\s+)?class\\s+${escaped}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let)\\s+${escaped}\\s*(?::[^=]+)?=`),
  ];
}

function annotateDiffSymbols(files, symbols) {
  const symbolList = Object.values(symbols)
    .filter((symbol) => isGoodSymbolName(symbol.name))
    .sort((a, b) => b.name.length - a.name.length);
  if (symbolList.length === 0) return;

  const symbolByName = new Map(symbolList.map((symbol) => [symbol.name, symbol]));
  const names = symbolList.map((symbol) => escapeRegExp(symbol.name));
  const symbolRe = new RegExp(`\\b(${names.join("|")})\\b`, "g");

  for (const file of files) {
    if (!isCodeLikePath(file.path)) continue;
    for (const line of file.diff) {
      if (typeof line.c !== "string" || line.k === "hunk") continue;
      const parts = splitSymbolTokens(line.c, symbolRe, symbolByName);
      if (parts) line.c = parts;
    }
  }
}

function splitSymbolTokens(text, symbolRe, symbolByName) {
  const parts = [];
  let lastIndex = 0;
  let match;
  symbolRe.lastIndex = 0;

  while ((match = symbolRe.exec(text))) {
    const symbol = symbolByName.get(match[1]);
    if (!symbol || isInsideStringLiteral(text, match.index)) continue;
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push({ type: "symbol", label: match[1], id: symbol.id });
    lastIndex = match.index + match[1].length;
  }

  if (parts.length === 0) return null;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function isInsideStringLiteral(text, index) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < index; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") quote = ch;
  }
  return !!quote;
}

function statusForCallsite(filePath, touchedFile) {
  if (isTestPath(filePath)) return "test";
  if (touchedFile) return "touched";
  return "untouched";
}

function roleForLine(line, name) {
  const escaped = escapeRegExp(name);
  if (new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`).test(line)) return "write";
  if (new RegExp(`\\bfunction\\s+${escaped}\\b`).test(line)) return "write";
  if (new RegExp(`\\bclass\\s+${escaped}\\b`).test(line)) return "write";
  if (new RegExp(`\\b${escaped}\\s*=`).test(line)) return "write";
  return "read";
}

function isGoodSymbolName(name) {
  if (!name || name.length < 3) return false;
  const lower = name.toLowerCase();
  if (SYMBOL_IGNORE.has(lower)) return false;
  if (/^use[A-Z]/.test(name)) return true;
  if (/^[A-Z][A-Za-z0-9_$]*$/.test(name)) return true;
  if (/[A-Z_$]/.test(name)) return true;
  if (/^[a-z]+$/.test(name) && name.length < 5) return false;
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

function isCodeLikePath(filePath) {
  return /\.(mjs|cjs|js|jsx|ts|tsx)$/.test(filePath);
}

function isTestPath(filePath) {
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(filePath);
}

function isLikelyVendorPath(filePath) {
  return /(^|\/)(node_modules|dist|build|\.next|coverage|\.git)(\/|$)/.test(filePath);
}

function stripTrailingComment(line) {
  return line.replace(/\/\/.*$/, "");
}

function symbolId(prefix, name) {
  return `${prefix}-${slug(name)}`;
}

function escapeRegExpWord(value) {
  return `\\b${escapeRegExp(value)}\\b`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function createFile(filePath) {
  const group = groupForPath(filePath);
  return {
    group: group.key,
    groupReason: group.why,
    path: filePath,
    oldPath: null,
    tag: "modified",
    add: 0,
    del: 0,
    note: "",
    diff: [],
    notes: [],
  };
}

function finalizeFile(file, index) {
  const { oldPath, ...clean } = file;
  return {
    ...clean,
    path: clean.path || `file-${index}`,
    diffFingerprint: diffFingerprintForFile(clean),
  };
}

function diffFingerprintForFile(file) {
  const payload = JSON.stringify({
    path: file.path || "",
    tag: file.tag || "",
    add: Number(file.add) || 0,
    del: Number(file.del) || 0,
    diff: Array.isArray(file.diff)
      ? file.diff.map((line) => ({
        k: line.k,
        L: line.L ?? null,
        R: line.R ?? null,
        c: plainDiffContent(line.c),
      }))
      : [],
  });
  return `df1-${hashString(payload)}`;
}

function plainDiffContent(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof part.label === "string") return part.label;
    return "";
  }).join("");
}

function hashString(value) {
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

function parseDiffGitLine(line) {
  const parts = line.slice("diff --git ".length).match(/(?:\"(?:\\.|[^\"])+\"|\S+)/g) || [];
  return {
    oldPath: stripGitPrefix(unquotePath(parts[0] || "")),
    newPath: stripGitPrefix(unquotePath(parts[1] || "")),
  };
}

function parsePatchPath(value) {
  if (value === "/dev/null") return null;
  return stripGitPrefix(unquotePath(value.split("\t")[0]));
}

function stripGitPrefix(value) {
  return value.replace(/^[ab]\//, "");
}

function unquotePath(value) {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value.slice(1, -1);
  }
}

function groupForPath(filePath) {
  return GROUPS.find((group) => group.tests.some((test) => test.test(filePath))) || GROUPS.at(-1);
}

function groupsFor(files) {
  const seen = new Set(files.map((file) => file.group));
  return GROUPS
    .filter((group) => seen.has(group.key))
    .map(({ key, why }) => ({ key, label: key, why }));
}

function authorFrom(author) {
  const name = author?.name || author?.login || "Unknown";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
  return { name, initials };
}

function validateAha(pack) {
  JSON.parse(JSON.stringify(pack));
  const requiredFileKeys = ["path", "group", "tag", "add", "del", "diff", "notes"];
  const filePaths = new Set(pack.files.map((file) => file.path));
  const fileById = new Map(pack.files.flatMap((file) => (file.id ? [[file.id, file]] : [])));
  const fileByPath = new Map(pack.files.map((file) => [file.path, file]));
  const symbolIds = new Set(Object.keys(pack.symbols || {}));
  for (const file of pack.files) {
    if ("id" in file) {
      throw new CliError(`Generated file entry uses legacy id; use path: ${file.path || file.id}`);
    }
    for (const key of requiredFileKeys) {
      if (!(key in file)) throw new CliError(`Generated file entry is missing ${key}: ${file.path || file.id}`);
    }
    if (!["new", "modified", "deleted", "unchanged"].includes(file.tag)) {
      throw new CliError(`Generated file entry has invalid tag ${file.tag}: ${file.path}`);
    }
    for (const line of file.diff) {
      const keys = Object.keys(line).sort().join(",");
      const valid = (
        keys === "L,R,c,k" ||
        keys === "L,c,k" ||
        keys === "R,c,k" ||
        keys === "c,k"
      );
      if (!valid || !["hunk", "ctx", "add", "del"].includes(line.k)) {
        throw new CliError(`Generated invalid diff line in ${file.path}`);
      }
      for (const token of symbolTokensFromLine(line)) {
        if (!symbolIds.has(token.id)) {
          throw new CliError(`Generated symbol token references missing symbol ${token.id} in ${file.path}`);
        }
      }
    }
  }

  for (const [id, symbol] of Object.entries(pack.symbols || {})) {
    if (!symbol || typeof symbol !== "object") throw new CliError(`Generated invalid symbol ${id}`);
    for (const key of ["name", "kind", "defined", "callers"]) {
      if (!(key in symbol)) throw new CliError(`Generated symbol ${id} is missing ${key}`);
    }
    if (!symbol.defined || typeof symbol.defined !== "object") {
      throw new CliError(`Generated symbol ${id} has invalid definition`);
    }
    if (symbol.defined.fileId != null) {
      throw new CliError(`Generated symbol ${id} uses legacy defined.fileId; use defined.path`);
    }
    if (!Array.isArray(symbol.callers)) {
      throw new CliError(`Generated symbol ${id} callers must be an array`);
    }
    for (const caller of symbol.callers) {
      if (caller.fileId != null) {
        throw new CliError(`Generated symbol ${id} caller uses legacy fileId; use path`);
      }
      validateCallerContext(caller, `Generated symbol ${id} caller ${caller.path}:${caller.line}`);
    }
    if (symbol.notCallers != null && !Array.isArray(symbol.notCallers)) {
      throw new CliError(`Generated symbol ${id} notCallers must be an array`);
    }
    for (const caller of symbol.notCallers || []) {
      if (caller.fileId != null) {
        throw new CliError(`Generated symbol ${id} notCaller uses legacy fileId; use path`);
      }
      validateCallerContext(caller, `Generated symbol ${id} notCaller ${caller.path}:${caller.line}`);
    }
  }

  validateOverviewRefs(pack, { filePaths, symbolIds });
  validateReviewSignals(pack, { fileByPath, fileById });
}

function symbolTokensFromLine(line) {
  if (!Array.isArray(line.c)) return [];
  return line.c.filter((part) => part && typeof part === "object" && part.type === "symbol");
}

function validateOverviewRefs(pack, { filePaths, symbolIds }) {
  if (!pack.overview) return;
  const decisionIds = new Set((pack.decisions?.cards || []).map((card) => card.id).filter(Boolean));
  for (const ref of overviewRefs(pack.overview)) {
    if (ref.type === "symbol" && !symbolIds.has(ref.id)) {
      throw new CliError(`Overview references missing symbol ${ref.id}`);
    }
    if (ref.type === "file" && !filePaths.has(ref.id)) {
      throw new CliError(`Overview references missing file ${ref.id}`);
    }
    if (ref.type === "decision" && !decisionIds.has(ref.id)) {
      throw new CliError(`Overview references missing decision ${ref.id}`);
    }
  }
}

function overviewRefs(overview) {
  const refs = [];
  collectRichRefs(overview.mentalModelDelta, refs);
  if (overview.systemMap && typeof overview.systemMap === "object") {
    for (const line of Array.isArray(overview.systemMap.lines) ? overview.systemMap.lines : []) collectRichRefs(line, refs);
    refs.push(...validOverviewRefs(overview.systemMap.refs));
  }
  for (const delta of Array.isArray(overview.modelDeltas) ? overview.modelDeltas : []) {
    collectRichRefs(delta.title, refs);
    collectRichRefs(delta.before, refs);
    collectRichRefs(delta.after, refs);
    refs.push(...validOverviewRefs(delta.refs));
  }
  for (const flow of Array.isArray(overview.flows) ? overview.flows : []) {
    for (const line of Array.isArray(flow.lines) ? flow.lines : []) collectRichRefs(line, refs);
    for (const line of Array.isArray(flow.before) ? flow.before : []) collectRichRefs(line, refs);
    for (const line of Array.isArray(flow.after) ? flow.after : []) collectRichRefs(line, refs);
  }
  for (const assumption of Array.isArray(overview.assumptions) ? overview.assumptions : []) {
    collectRichRefs(assumption.text, refs);
    refs.push(...validOverviewRefs(assumption.refs));
  }
  for (const hotspot of Array.isArray(overview.hotspots) ? overview.hotspots : []) {
    collectRichRefs(hotspot.title, refs);
    collectRichRefs(hotspot.why, refs);
    refs.push(...validOverviewRefs(hotspot.refs));
  }
  return refs;
}

function collectRichRefs(value, refs) {
  if (!Array.isArray(value)) return;
  refs.push(...validOverviewRefs(value));
}

function validateCallerContext(caller, label) {
  if (!caller.context || typeof caller.context !== "object" || Array.isArray(caller.context)) {
    throw new CliError(`${label} is missing context`);
  }
  if (!Number.isFinite(Number(caller.context.start)) || !Number.isFinite(Number(caller.context.end))) {
    throw new CliError(`${label} context must include numeric start/end`);
  }
  if (!Array.isArray(caller.context.lines) || caller.context.lines.length === 0) {
    throw new CliError(`${label} context.lines must be a non-empty array`);
  }
  const callerLine = Number(caller.line);
  if (!Number.isFinite(callerLine) || callerLine <= 0) return;
  let includesCallerLine = false;
  for (const [index, line] of caller.context.lines.entries()) {
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      throw new CliError(`${label} context.lines[${index}] must be an object`);
    }
    if (!Number.isFinite(Number(line.line))) {
      throw new CliError(`${label} context.lines[${index}].line must be numeric`);
    }
    if (typeof line.c !== "string") {
      throw new CliError(`${label} context.lines[${index}].c must be a string`);
    }
    if (Number(line.line) === callerLine) includesCallerLine = true;
  }
  if (!includesCallerLine) {
    throw new CliError(`${label} context must include the caller line`);
  }
}

function validOverviewRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((part) => part && ["symbol", "file", "decision"].includes(part.type) && typeof part.id === "string");
}

function validateReviewSignals(pack, { fileByPath, fileById }) {
  if (!pack.reviewSignals) return;
  if (typeof pack.reviewSignals !== "object" || Array.isArray(pack.reviewSignals)) {
    throw new CliError("reviewSignals must be an object");
  }
  const patternIds = validateReviewSignalPatterns(pack.reviewSignals.patterns);
  const signals = pack.reviewSignals.files || {};
  if (typeof signals !== "object" || Array.isArray(signals)) {
    throw new CliError("reviewSignals.files must be an object keyed by file path");
  }
  for (const [fileKey, signal] of Object.entries(signals)) {
    const file = fileByPath.get(fileKey) || fileById.get(fileKey);
    if (!file) throw new CliError(`reviewSignals references missing file ${fileKey}`);
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
      throw new CliError(`reviewSignals.${fileKey} must be an object`);
    }
    if (!REVIEW_SIGNAL_RELEVANCE.has(signal.relevance)) {
      throw new CliError(`reviewSignals.${fileKey} has invalid relevance ${signal.relevance}`);
    }
    if (signal.source != null && !["ai", "deterministic", "manual"].includes(signal.source)) {
      throw new CliError(`reviewSignals.${fileKey} has invalid source ${signal.source}`);
    }
    if (signal.ranges != null && !Array.isArray(signal.ranges)) {
      throw new CliError(`reviewSignals.${fileKey}.ranges must be an array`);
    }
    const seenRangeIds = new Set();
    const noiseRanges = [];
    for (const [index, range] of (signal.ranges || []).entries()) {
      validateSignalRange(file, range, `reviewSignals.${fileKey}.ranges[${index}]`, patternIds, seenRangeIds, fileByPath);
      if (range?.relevance === "noise") noiseRanges.push(range);
    }
    validateNoOverlappingNoiseRanges(noiseRanges, `reviewSignals.${fileKey}.ranges`);
  }
}

function validateReviewSignalPatterns(patterns) {
  if (patterns == null) return new Set();
  if (typeof patterns !== "object" || Array.isArray(patterns)) {
    throw new CliError("reviewSignals.patterns must be an object keyed by pattern id");
  }
  const patternIds = new Set();
  for (const [patternId, pattern] of Object.entries(patterns)) {
    if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) {
      throw new CliError(`reviewSignals.patterns.${patternId} must be an object`);
    }
    if (pattern.id != null && pattern.id !== patternId) {
      throw new CliError(`reviewSignals.patterns.${patternId}.id must match the pattern key`);
    }
    if (typeof pattern.label !== "string" || !pattern.label.trim()) {
      throw new CliError(`reviewSignals.patterns.${patternId}.label must be a non-empty string`);
    }
    if (pattern.source != null && !["user", "ai"].includes(pattern.source)) {
      throw new CliError(`reviewSignals.patterns.${patternId}.source has invalid source ${pattern.source}`);
    }
    if (pattern.description != null && typeof pattern.description !== "string") {
      throw new CliError(`reviewSignals.patterns.${patternId}.description must be a string`);
    }
    patternIds.add(patternId);
  }
  return patternIds;
}

function validateSignalRange(file, range, label, patternIds = new Set(), seenRangeIds = new Set(), fileByPath = new Map()) {
  if (!range || typeof range !== "object" || Array.isArray(range)) throw new CliError(`${label} must be an object`);
  if (range.id != null) {
    if (typeof range.id !== "string" || !range.id.trim()) throw new CliError(`${label}.id must be a non-empty string`);
    if (seenRangeIds.has(range.id)) throw new CliError(`${label}.id duplicates range id ${range.id}`);
    seenRangeIds.add(range.id);
  }
  if (!REVIEW_SIGNAL_RELEVANCE.has(range.relevance)) {
    throw new CliError(`${label} has invalid relevance ${range.relevance}`);
  }
  if (range.source != null && !["ai", "deterministic", "manual"].includes(range.source)) {
    throw new CliError(`${label} has invalid source ${range.source}`);
  }
  if (range.kind === "mechanical-pattern" && range.patternId == null) {
    throw new CliError(`${label} with kind mechanical-pattern must include patternId`);
  }
  if (range.patternId != null && range.kind !== "mechanical-pattern") {
    throw new CliError(`${label}.patternId requires kind mechanical-pattern`);
  }
  if (range.patternId != null && !patternIds.has(range.patternId)) {
    throw new CliError(`${label}.patternId references missing reviewSignals.patterns entry ${range.patternId}`);
  }
  if (isMovedUnchangedSignalKind(range.kind)) {
    if (range.relevance !== "context") {
      throw new CliError(`${label} with kind ${range.kind} must use relevance context`);
    }
    if (range.hideByDefault !== false) {
      throw new CliError(`${label} with kind ${range.kind} must set hideByDefault false`);
    }
    if (range.scope != null && (!range.scope || typeof range.scope !== "object" || Array.isArray(range.scope))) {
      throw new CliError(`${label}.scope must be an object when present`);
    }
    if (range.scope != null && (typeof range.scope.before !== "string" || typeof range.scope.after !== "string")) {
      throw new CliError(`${label}.scope must include before and after strings`);
    }
  }
  const left = range.anchor?.left;
  const right = range.anchor?.right;
  if (!left && !right) throw new CliError(`${label} must include anchor.left or anchor.right`);
  if (!rangeIncludesOwnerFile(range, file.path)) {
    throw new CliError(`${label} must be stored under one of its anchor file paths`);
  }
  if (isMovedUnchangedSignalKind(range.kind) && (!left || !right)) {
    throw new CliError(`${label} with kind ${range.kind} must include anchor.left and anchor.right`);
  }
  if (left) validateAnchor(file, left, "L", `${label}.anchor.left`, fileByPath);
  if (right) validateAnchor(file, right, "R", `${label}.anchor.right`, fileByPath);
}

function isMovedUnchangedSignalKind(kind) {
  return kind === "moved-unchanged" || kind === "moved-unchanged-scope-change";
}

function rangeIncludesOwnerFile(range, ownerPath) {
  for (const side of ["left", "right"]) {
    const anchor = range.anchor?.[side];
    if (!anchor) continue;
    if (!anchor.path || anchor.path === ownerPath) return true;
  }
  return false;
}

function validateNoOverlappingNoiseRanges(ranges, label) {
  for (const side of ["left", "right"]) {
    const seen = new Map();
    for (const range of ranges) {
      const anchor = range.anchor?.[side];
      if (!anchor) continue;
      const pathKey = typeof anchor.path === "string" && anchor.path.trim() ? anchor.path : "";
      const start = Number(anchor.start);
      const end = Number(anchor.end ?? anchor.start);
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      for (let line = min; line <= max; line += 1) {
        const key = `${pathKey}:${line}`;
        if (seen.has(key)) {
          throw new CliError(`${label} has overlapping noise ranges on ${side} line ${line}`);
        }
        seen.set(key, range.id || "(unnamed)");
      }
    }
  }
}

function validateAnchor(file, anchor, side, label, fileByPath = new Map()) {
  const anchorFile = typeof anchor.path === "string" && anchor.path.trim()
    ? fileByPath.get(anchor.path)
    : file;
  if (!anchorFile) throw new CliError(`${label}.path references missing file ${anchor.path}`);
  const start = Number(anchor.start);
  const end = Number(anchor.end ?? anchor.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new CliError(`${label} must have numeric start/end`);
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  const lines = new Set((Array.isArray(anchorFile.diff) ? anchorFile.diff : [])
    .filter((line) => line[side] != null && line[side] >= min && line[side] <= max)
    .map((line) => Number(line[side])));
  if (lines.size === 0) throw new CliError(`${label} does not match any diff line in ${anchorFile.path}`);
  for (let line = min; line <= max; line += 1) {
    if (!lines.has(line)) {
      throw new CliError(`${label} does not cover diff ${side} line ${line} in ${anchorFile.path}`);
    }
  }
}

async function assertGitRepo(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    if (stdout.trim() !== "true") throw new Error("not inside work tree");
  } catch {
    throw new CliError("Not in a git repository. Run this from inside the target repo.");
  }
}

async function assertGhAvailable() {
  try {
    await execFileAsync("gh", ["--version"]);
  } catch (error) {
    if (error.code !== "ENOENT") {
      const stderr = String(error.stderr || error.message || "").trim();
      throw new CliError(`GitHub CLI \`gh\` could not run${stderr ? `:\n${stderr}` : "."}`);
    }
    throw new CliError("GitHub CLI `gh` is missing. Install it and authenticate with `gh auth login`.");
  }
}

async function assertGhAuthenticated(cwd) {
  try {
    await execFileAsync("gh", ["auth", "status"], { cwd });
  } catch {
    throw new CliError("GitHub CLI is not authenticated. Run `gh auth login`.");
  }
}

async function ghJson(args, cwd) {
  const text = await ghText(args, cwd);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`Could not parse gh JSON output: ${error.message}`);
  }
}

async function ghText(args, cwd) {
  try {
    const { stdout } = await execFileAsync("gh", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = String(error.stderr || "").trim();
    const stdout = String(error.stdout || "").trim();
    throw new CliError(`gh ${args.join(" ")} failed${stderr || stdout ? `:\n${stderr || stdout}` : "."}`);
  }
}

function resolveAndValidatePack(packPath) {
  const resolvedPackPath = path.resolve(process.cwd(), packPath);
  if (!fs.existsSync(resolvedPackPath)) {
    throw new CliError(`Pack does not exist: ${resolvedPackPath}`);
  }

  try {
    JSON.parse(fs.readFileSync(resolvedPackPath, "utf8"));
  } catch (error) {
    throw new CliError(`Pack is not valid JSON: ${resolvedPackPath}\n${error.message}`);
  }

  return resolvedPackPath;
}

async function servePack({ packPath, openBrowser, port, host, empty = false }) {
  const server = await createServer({
    root,
    configFile: false,
    plugins: [ahaJsonPlugin(packPath, { cliCommand, empty }), react(), tailwindcss()],
    server: {
      host,
      port,
      strictPort: false,
    },
  });

  await server.listen();

  const info = server.resolvedUrls?.local?.[0] || `http://${host}:${port}/`;
  console.log(empty ? "aha serving empty viewer" : packPath ? `aha serving ${packPath}` : `aha serving pack library ${packsRoot}`);
  console.log(info);

  if (openBrowser) {
    // Deep-link an explicit pack straight into the viewer; the bare URL lands
    // on the dashboard.
    let openUrl = info;
    if (packPath) {
      try {
        const url = new URL(info);
        url.searchParams.set("pack", packEntryForFile(packPath).id);
        openUrl = url.toString();
      } catch {
        openUrl = info;
      }
    }
    spawn("open", [openUrl], { stdio: "ignore", detached: true }).unref();
  }
}

function readArg(argv, name) {
  const index = argv.lastIndexOf(name);
  if (index === -1) return null;
  return argv[index + 1] || null;
}

function readArgs(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

function readFragmentPaths(argv) {
  return [
    ...readArgs(argv, "--fragment"),
    ...readArgs(argv, "--fragments").flatMap((value) => value.split(",")),
  ].map((value) => value.trim()).filter(Boolean);
}

function requiredArg(argv, name, usage) {
  const value = readArg(argv, name);
  if (!value) throw new CliError(`Missing required ${name}. Use ${usage}.`);
  return value;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "branch";
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function ahaJsonPlugin(packFile, runtime = {}) {
  return {
    name: "aha-json",
    configureServer(server) {
      server.middlewares.use("/aha-runtime.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({
          ahaCli: runtime.cliCommand || "aha",
        }, null, 2) + "\n");
      });
      server.middlewares.use("/aha-packs.json", (req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        if (runtime.empty) {
          res.end(JSON.stringify({ packs: [], selectedId: "" }, null, 2) + "\n");
          return;
        }
        const index = packIndexForServing(packFile);
        const selected = selectedPackEntry(req, index, packFile);
        res.end(JSON.stringify({
          packs: index,
          selectedId: selected?.id || "",
        }, null, 2) + "\n");
      });
      server.middlewares.use("/aha.json", (req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        if (runtime.empty) {
          res.end(JSON.stringify(emptyAha(), null, 2) + "\n");
          return;
        }
        const index = packIndexForServing(packFile);
        const selected = selectedPackEntry(req, index, packFile);
        if (!selected) {
          res.end(JSON.stringify(emptyAha(), null, 2) + "\n");
          return;
        }
        res.end(JSON.stringify(packForServing(selected.path), null, 2) + "\n");
      });
      server.middlewares.use("/aha-state.json", async (req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        if (runtime.empty) {
          if (req.method === "GET" || req.method === "HEAD") {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "No review state saved for empty viewer" }) + "\n");
            return;
          }
          if (req.method === "PUT" || req.method === "DELETE") {
            res.end(JSON.stringify({ ok: true, transient: true }) + "\n");
            return;
          }
        }
        const index = packIndexForServing(packFile);
        const selected = selectedPackEntry(req, index, packFile);
        const stateFile = selected ? stateFileForPack(selected.path) : null;

        try {
          if (req.method === "GET" || req.method === "HEAD") {
            if (stateFile && fs.existsSync(stateFile)) {
              if (req.method === "HEAD") {
                res.end();
                return;
              }
              fs.createReadStream(stateFile).pipe(res);
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "No review state saved for this pack" }) + "\n");
            return;
          }

          if (req.method === "PUT") {
            const body = await readRequestBody(req, 1024 * 1024);
            const state = sanitizeReviewState(JSON.parse(body || "{}"));
            if (!stateFile) {
              res.end(JSON.stringify({ ok: true, transient: true }) + "\n");
              return;
            }
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            // Unique per write so overlapping PUTs from this process can't clobber
            // each other's temp file mid-write (rename stays atomic-visible).
            const tmpFile = `${stateFile}.${process.pid}.${stateWriteSeq++}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2) + "\n");
            fs.renameSync(tmpFile, stateFile);
            res.end(JSON.stringify({ ok: true, path: stateFile }) + "\n");
            return;
          }

          if (req.method === "DELETE") {
            if (stateFile && fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
            res.end(JSON.stringify({ ok: true }) + "\n");
            return;
          }

          res.statusCode = 405;
          res.end(JSON.stringify({ error: "Method not allowed" }) + "\n");
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: error.message }) + "\n");
        }
      });
      // Repos the dashboard may initialize from. Names only — paths stay here.
      server.middlewares.use("/aha-repos.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        const repos = readLocalRepos().map((repo) => ({ name: repo.name }));
        res.end(JSON.stringify({ repos }, null, 2) + "\n");
      });
      // Deterministic init: run the existing `generate` path against an
      // allowlisted repo + numeric PR, then hand back the new pack id so the
      // app can open it. No AI here — that stays a later step.
      server.middlewares.use("/aha-generate", async (req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "Method not allowed" }) + "\n");
          return;
        }
        if (runtime.empty) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "Initializing is disabled in the empty viewer" }) + "\n");
          return;
        }
        if (!isLocalOrigin(req)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "Cross-origin request rejected" }) + "\n");
          return;
        }
        try {
          const body = await readRequestBody(req, 64 * 1024);
          const payload = JSON.parse(body || "{}");
          const pr = String(payload?.pr ?? "").trim();
          if (!/^\d+$/.test(pr)) throw new CliError("PR number must be digits.");
          const repoPath = resolveRepoForGenerate(payload);
          const outputPath = await generateFromPr({ prNumber: pr, cwd: repoPath });
          const entry = packEntryForFile(outputPath);
          res.end(JSON.stringify({ ok: true, id: entry.id, path: outputPath, pr, repo: entry.repo }) + "\n");
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
        }
      });
      // Delete a pack (and its sidecars/fragments) from the library.
      server.middlewares.use("/aha-delete", async (req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "Method not allowed" }) + "\n");
          return;
        }
        if (runtime.empty) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "Deleting is disabled in the empty viewer" }) + "\n");
          return;
        }
        if (!isLocalOrigin(req)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "Cross-origin request rejected" }) + "\n");
          return;
        }
        try {
          const body = await readRequestBody(req, 64 * 1024);
          const payload = JSON.parse(body || "{}");
          res.end(JSON.stringify(deletePackById(String(payload?.id || ""))) + "\n");
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
        }
      });
    },
  };
}

function selectedPackEntry(req, index, packFile) {
  const selectedId = packIdFromRequest(req);
  if (selectedId) return index.find((entry) => entry.id === selectedId) || null;
  if (packFile) return index.find((entry) => entry.path === packFile) || packEntryForFile(packFile);
  return index[0] || null;
}

function packIdFromRequest(req) {
  try {
    const url = new URL(req.url || "", "http://127.0.0.1");
    const value = url.searchParams.get("pack");
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function packIndexForServing(packFile) {
  const entries = listPackEntries();
  if (packFile && !entries.some((entry) => entry.path === packFile)) {
    entries.unshift(packEntryForFile(packFile));
  }
  return entries;
}

function listPackEntries() {
  const files = listJsonFiles(packsRoot).filter((file) => isServablePackFile(file));
  return files
    .map((file) => packEntryForFile(file))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(fullPath);
  }
  return out;
}

function isServablePackFile(file) {
  if (file.split(path.sep).includes("fragments")) return false;
  const base = path.basename(file);
  if (base.endsWith(".state.json") || base.endsWith(".update-report.json")) return false;
  if (base.includes(".pre-") || base.includes(".ai-backup.") || base.includes(".generated-check.")) return false;
  if (base.endsWith("-base.json")) return false;
  try {
    const pack = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(pack.files);
  } catch {
    return false;
  }
}

function packEntryForFile(file) {
  const resolved = path.resolve(file);
  let pack = {};
  try {
    pack = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    // Keep a broken entry out of normal indexes; explicit --pack validation
    // already catches parse errors before the server starts.
  }
  const rel = path.relative(packsRoot, resolved);
  const parts = rel && !rel.startsWith("..") ? rel.split(path.sep) : [];
  const stat = fs.statSync(resolved);
  const repo = pack.repositoryName || pack.repoName || pack.repository?.name || parts[0] || repositoryNameFromPackPath(resolved);
  const pr = pack.number || parts[1] || "";
  const id = parts.length ? parts.join("/") : `external/${hashString(resolved)}/${path.basename(resolved)}`;
  return {
    id,
    path: resolved,
    repo,
    pr,
    title: pack.title || path.basename(resolved),
    branch: pack.branch || "",
    base: pack.base || "",
    kind: path.basename(resolved).startsWith("reviewpack-") ? "reviewpack" : "aha",
    updatedAt: stat.mtime.toISOString(),
    filesChanged: Array.isArray(pack.files) ? pack.files.length : 0,
    reviewed: reviewedCountForPack(resolved),
    ...focusProgressForPack(resolved, pack),
  };
}

// Cheap glance at how far a pack's local review got — drives the dashboard
// progress bars without the client having to fetch every state sidecar.
function reviewedCountForPack(packFile) {
  try {
    const stateFile = stateFileForPack(packFile);
    if (!fs.existsSync(stateFile)) return 0;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (Array.isArray(state.viewed)) return state.viewed.length;
    if (state.viewedFiles && typeof state.viewedFiles === "object") return Object.keys(state.viewedFiles).length;
    return 0;
  } catch {
    return 0;
  }
}

// Review Focus burn-down per pack: total = decisions + hotspots + assumptions;
// decided/flagged/blocked come from the per-pack triage in the state sidecar.
function focusProgressForPack(packFile, pack) {
  // The ids that still exist in the pack — triage for any other id is an orphan
  // (a retired/renamed item) and must not count toward progress.
  const focusIds = new Set(
    [
      ...(Array.isArray(pack?.decisions?.cards) ? pack.decisions.cards : []),
      ...(Array.isArray(pack?.overview?.hotspots) ? pack.overview.hotspots : []),
      ...(Array.isArray(pack?.overview?.assumptions) ? pack.overview.assumptions : []),
    ]
      .map((item) => item?.id)
      .filter((id) => typeof id === "string" && id),
  );
  const focusTotal = focusIds.size;
  let decided = 0;
  let focusFlagged = 0;
  let focusBlocked = 0;
  try {
    const stateFile = stateFileForPack(packFile);
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (state?.decisions && typeof state.decisions === "object") {
        for (const [id, value] of Object.entries(state.decisions)) {
          if (!focusIds.has(id)) continue;
          if (value === "accept" || value === "flag" || value === "block") decided += 1;
          if (value === "flag") focusFlagged += 1;
          if (value === "block") focusBlocked += 1;
        }
      }
    }
  } catch {
    // ignore unreadable/partial state
  }
  return { focusTotal, focusDecided: decided, focusFlagged, focusBlocked };
}

// Target repos the served app may initialize PRs from. Names only ever cross to
// the browser; the absolute path stays server-side so init is a fixed allowlist.
function readLocalRepos() {
  try {
    const raw = fs.readFileSync(path.join(root, ".aha.local.json"), "utf8");
    const repos = JSON.parse(raw)?.repos;
    if (!Array.isArray(repos)) return [];
    return repos
      .map((repo) => ({
        name: String(repo?.name || "").trim() || (repo?.path ? path.basename(String(repo.path)) : ""),
        path: String(repo?.path || "").trim(),
      }))
      .filter((repo) => repo.name && repo.path);
  } catch {
    return [];
  }
}

function resolveRepoForGenerate(payload) {
  const repos = readLocalRepos();
  const requested = String(payload?.repo || "").trim();
  if (requested) {
    const match = repos.find((repo) => repo.name === requested || repo.path === requested);
    if (!match) throw new CliError(`Unknown repo "${requested}". Register it under "repos" in .aha.local.json.`);
    return match.path;
  }
  if (repos.length === 1) return repos[0].path;
  throw new CliError("No repo selected. Register repos under \"repos\" in .aha.local.json and pick one.");
}

// Reject cross-origin POSTs so a stray web page can't drive command execution
// against the localhost server (CSRF / DNS-rebind). Same-origin fetches from the
// aha page itself either omit Origin or carry a localhost one.
function isLocalOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

// Delete a library pack and everything that belongs to it: the pack file, its
// basename-prefixed sidecars/backups (.state.json, .update-report.json,
// .pre-*), and — once no servable pack remains in the PR folder — the orphaned
// fragments plus the now-empty directory chain. Refuses anything outside
// packsRoot or served from an explicit external --pack.
function deletePackById(id) {
  if (!id || typeof id !== "string") throw new CliError("Missing pack id.");
  if (id.startsWith("external/")) throw new CliError("This pack is served from outside the library and can't be deleted here.");
  const resolved = path.resolve(packsRoot, id);
  const rootWithSep = packsRoot.endsWith(path.sep) ? packsRoot : packsRoot + path.sep;
  if (!resolved.startsWith(rootWithSep)) throw new CliError("Pack id escapes the library.");
  if (!fs.existsSync(resolved) || !isServablePackFile(resolved)) throw new CliError("Pack not found.");

  const dir = path.dirname(resolved);
  const packBasename = path.basename(resolved);
  const base = path.basename(resolved, path.extname(resolved));
  for (const entry of fs.readdirSync(dir)) {
    if (entry === packBasename || entry.startsWith(`${base}.`)) {
      fs.rmSync(path.join(dir, entry), { force: true, recursive: true });
    }
  }

  const stillHasPack = fs.readdirSync(dir).some((entry) => {
    const full = path.join(dir, entry);
    return fs.statSync(full).isFile() && isServablePackFile(full);
  });
  if (!stillHasPack) {
    fs.rmSync(dir, { recursive: true, force: true });
    let parent = path.dirname(dir);
    while (parent.startsWith(rootWithSep) && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
      parent = path.dirname(parent);
    }
  }
  return { ok: true, id };
}

function packForServing(packFile) {
  const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));
  if (!pack.repositoryName && !pack.repoName && !pack.repository?.name) {
    const repoName = repositoryNameFromPackPath(packFile);
    if (repoName) pack.repositoryName = repoName;
  }
  return pack;
}

async function repositoryNameForCwd(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    return path.basename(stdout.trim()) || path.basename(cwd);
  } catch {
    return path.basename(cwd);
  }
}

function repositoryNameFromPackPath(packFile) {
  const parts = path.resolve(packFile).split(path.sep);
  const packsParts = packsRoot.split(path.sep);
  if (parts.slice(0, packsParts.length).join(path.sep) === packsParts.join(path.sep)) {
    return parts[packsParts.length] || path.basename(path.dirname(packFile));
  }
  const ahaIndex = parts.lastIndexOf(".aha");
  if (ahaIndex > 0) return parts[ahaIndex - 1];
  const reviewpackIndex = parts.lastIndexOf(".reviewpack");
  if (reviewpackIndex > 0) return parts[reviewpackIndex - 1];
  return path.basename(path.dirname(packFile));
}

function stateFileForPack(packFile) {
  const ext = path.extname(packFile);
  const base = path.basename(packFile, ext);
  return path.join(path.dirname(packFile), `${base}.state.json`);
}

function emptyAha() {
  return {
    schemaVersion: "0.1",
    repositoryName: "",
    number: 0,
    title: "Empty aha",
    oneLiner: "Start the viewer, then generate or load an aha.json.",
    branch: "",
    base: "",
    author: { name: "", initials: "" },
    opened: "",
    filesChanged: 0,
    added: 0,
    removed: 0,
    files: [],
    symbols: {},
    groups: [],
    readingOrders: [],
    decisions: {
      categories: [],
      cards: [],
      questions: [],
    },
  };
}

function backupPathFor(file, label) {
  const ext = path.extname(file);
  const base = ext ? file.slice(0, -ext.length) : file;
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}.${label}-${suffix}${ext}`;
}

function reportPathFor(file) {
  const ext = path.extname(file);
  const base = ext ? file.slice(0, -ext.length) : file;
  return `${base}.update-report.json`;
}

// Monotonic per-process counter for unique state temp-file names.
let stateWriteSeq = 0;

function sanitizeReviewState(input) {
  const viewed = Array.isArray(input?.viewed)
    ? Array.from(new Set(input.viewed.filter((id) => typeof id === "string")))
    : [];
  const viewedFiles = {};
  if (input?.viewedFiles && typeof input.viewedFiles === "object") {
    for (const [fileId, entry] of Object.entries(input.viewedFiles)) {
      if (typeof fileId !== "string" || !entry || typeof entry !== "object") continue;
      const diffFingerprint = typeof entry.diffFingerprint === "string" ? entry.diffFingerprint : "";
      if (!diffFingerprint) continue;
      viewedFiles[fileId] = {
        diffFingerprint,
        viewedAt: typeof entry.viewedAt === "string" ? entry.viewedAt : "",
      };
    }
  }
  const decisions = {};
  if (input?.decisions && typeof input.decisions === "object") {
    for (const [id, status] of Object.entries(input.decisions)) {
      if (typeof id === "string" && ["accept", "flag", "block"].includes(status)) {
        decisions[id] = status;
      }
    }
  }
  const baselines = {};
  if (input?.baselines && typeof input.baselines === "object") {
    for (const [id, raw] of Object.entries(input.baselines)) {
      // Keep a content baseline only for an item that is still triaged.
      if (typeof id !== "string" || !decisions[id] || !raw || typeof raw !== "object") continue;
      baselines[id] = {
        lens: ["decide", "inspect", "verify"].includes(raw.lens) ? raw.lens : "decide",
        title: typeof raw.title === "string" ? raw.title : "",
        body: typeof raw.body === "string" ? raw.body : "",
        check: typeof raw.check === "string" ? raw.check : "",
        sig: typeof raw.sig === "string" ? raw.sig : "",
        at: typeof raw.at === "string" ? raw.at : "",
      };
    }
  }
  return {
    schemaVersion: "0.2",
    viewed,
    viewedFiles,
    decisions,
    baselines,
    updatedAt: new Date().toISOString(),
  };
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new CliError("Review state payload is too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function printHelp() {
  console.log(`Usage:
  aha serve [--pack ./aha.json] [--port 4173]
  aha start [--port 4173]
  aha review --pack ./aha.json [--port 4173]
  aha generate --pr <number> [--out ./aha.json]
  aha update --pr <number> --pack ./aha.json [--out ./aha.json]
  aha normalize --pack ./aha.json [--out ./aha.json]
  aha merge --pack ./aha.json --fragments ./code-context.json,./review-signals.json,./review-judgment.json [--out ./aha.json]
  aha prompt --mode init --pr <number> --repo /path/to/repo
  aha prompt --mode update --pr <number> --repo /path/to/repo --pack ./aha.json
  aha review --pr <number> [--out ./aha.json] [--port 4173]

Without --pack, aha serve opens the central packs/<repo>/<pr>/ library with an in-app pack picker.`);
}
