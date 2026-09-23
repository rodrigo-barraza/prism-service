import crypto from "node:crypto";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// WorkspaceInstructions — AGENTS.md / CLAUDE.md / PRISM.md and rules, per turn
// ────────────────────────────────────────────────────────────
// When a turn has a workspace, its instruction files are read at turn start
// from the workspace root down to the working directory: the directory the
// agent works in (the request's workspaceRoot, a sub-agent's worktree). The
// workspace root is the outermost registered root (tools-service's list)
// that holds the working directory; a working directory outside every root
// is its own root. In each directory, in this order: AGENTS.md, CLAUDE.md,
// PRISM.md, then the Markdown files under .claude/rules/ and .prism/rules/.
//
// Files are read through tools-service — the machine the workspace is on,
// or the workspace agent serving it (WorkspaceFileSource) — and cached by
// real path, invalidated by mtime and size: a turn where nothing changed
// costs one stat round trip.
//
// A rule is a Markdown file with optional YAML frontmatter. Without `paths:`
// it is always on, like an instruction file. With `paths:` (a glob or a list
// of globs, relative to the directory that holds its .claude/ or .prism/) it
// applies only when the agent reads or edits a matching file — see
// harnesses/lifecycle/WorkspaceRuleStage.ts.
//
// How these join PRISM.md in the prompt, and in what order, is
// InstructionsSection.ts.
// ────────────────────────────────────────────────────────────

export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md", "PRISM.md"] as const;
export type InstructionFileName = (typeof INSTRUCTION_FILE_NAMES)[number];

/** Rule folders, per directory, in reading order. */
export const RULE_DIRECTORIES = [".claude/rules", ".prism/rules"] as const;

/** The most of one file that reaches the prompt. */
export const WORKSPACE_INSTRUCTION_FILE_MAX_CHARS = 100_000;

/** Directories read between the root and the working directory, the deepest kept. */
const MAX_DIRECTORY_LEVELS = 16;

/** Cached texts, by real path. */
const TEXT_CACHE_MAX_ENTRIES = 512;

export interface FileStat {
  /** The path as requested. */
  path: string;
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  sizeBytes: number;
  lastModified: string;
  /** Line count of a readable text file; null when the source did not count. */
  lines: number | null;
  /** The path the stat resolved to (a symlink's target). */
  realPath: string;
}

/** Where workspace files are read from (tools-service in production). */
export interface WorkspaceFileSource {
  /** Stat every path, in order. A path that cannot be stat'ed reads as missing. */
  stat(paths: string[]): Promise<FileStat[]>;
  /** Regular files under a directory, recursively, as absolute paths. */
  listFiles(directory: string): Promise<string[]>;
  /** Whole text files, by path; a file that could not be read is absent. */
  read(files: Array<{ path: string; lines: number }>): Promise<Map<string, string>>;
}

export interface WorkspaceInstructionFile {
  path: string;
  name: InstructionFileName;
  directory: string;
  content: string;
  /** Other files with the same text, shown once under this one (an AGENTS.md that is CLAUDE.md). */
  sameAs: string[];
  truncated: boolean;
  lastModified: string;
}

export interface WorkspaceRule {
  path: string;
  /** The directory `paths:` globs are relative to: the one holding .claude/ or .prism/. */
  base: string;
  /** Empty: always on. */
  globs: string[];
  /** The body, frontmatter removed. */
  content: string;
  truncated: boolean;
  lastModified: string;
}

export interface WorkspaceInstructions {
  root: string;
  workingDirectory: string;
  /** The directories read, from the root down to the working directory. */
  directories: string[];
  files: WorkspaceInstructionFile[];
  rules: WorkspaceRule[];
  /** Files found but not loaded, and why. */
  skipped: Array<{ path: string; reason: string }>;
  /** The worktree read in its repository's place, when there was one. */
  worktree?: WorktreeStandIn | null;
}

/**
 * A worktree standing in for the repository it checks out: directories at
 * or below `repository` are read from the same place under `worktree`, so a
 * sub-agent in an isolated worktree sees the instructions its parent sees,
 * with the repository's own files from its branch.
 */
export interface WorktreeStandIn {
  repository: string;
  worktree: string;
}

export interface DiscoverOptions {
  registeredRoots?: readonly string[];
  source: WorkspaceFileSource;
  worktree?: WorktreeStandIn | null;
  /** The ceiling for one file's text in the result. */
  maxFileChars?: number;
}

interface CachedText {
  lastModified: string;
  sizeBytes: number;
  text: string;
}

const textCache = new Map<string, CachedText>();

function rememberText(realPath: string, entry: CachedText): void {
  textCache.delete(realPath);
  if (textCache.size >= TEXT_CACHE_MAX_ENTRIES) {
    const oldest = textCache.keys().next().value;
    if (oldest !== undefined) textCache.delete(oldest);
  }
  textCache.set(realPath, entry);
}

/** Tests only: forget every cached text. */
export function _clearWorkspaceInstructionCache(): void {
  textCache.clear();
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

/** Byte order, not locale order: the prompt must not move with ICU data. */
function byteOrder(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The outermost registered root holding `workingDirectory`; else the directory itself. */
export function workspaceRootFor(
  workingDirectory: string,
  registeredRoots: readonly string[] = [],
): string {
  const directory = path.posix.resolve(workingDirectory);
  const holding = registeredRoots
    .filter((root): root is string => typeof root === "string" && root.trim() !== "")
    .map((root) => path.posix.resolve(root))
    .filter((root) => isWithin(root, directory))
    .sort((left, right) => left.length - right.length);
  return holding[0] ?? directory;
}

/** `root`, each directory below it, and `workingDirectory` last — at most the deepest 16. */
export function directoryChain(root: string, workingDirectory: string): string[] {
  const top = path.posix.resolve(root);
  const bottom = path.posix.resolve(workingDirectory);
  if (!isWithin(top, bottom)) return [bottom];
  const chain = [top];
  const relative = path.posix.relative(top, bottom);
  let current = top;
  for (const segment of relative ? relative.split("/") : []) {
    current = path.posix.join(current, segment);
    chain.push(current);
  }
  return chain.slice(-MAX_DIRECTORY_LEVELS);
}

/** A workspace path as the workspace names it: relative to the root when inside it. */
export function workspaceDisplayName(root: string, filePath: string): string {
  const relative = path.posix.relative(root, filePath);
  return relative && !relative.startsWith("..") && !path.posix.isAbsolute(relative)
    ? relative
    : filePath;
}

/**
 * Where a stand-in keeps `logical`: the same place under the worktree when
 * it is inside the repository, else unchanged — as WorktreePathRewrite
 * moves a tool call's path arguments.
 */
export function throughWorktree(logical: string, worktree: WorktreeStandIn | null | undefined): string {
  if (!worktree || !isWithin(worktree.repository, logical)) return logical;
  return path.posix.join(worktree.worktree, path.posix.relative(worktree.repository, logical));
}

// ── Rules ─────────────────────────────────────────────────────

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Split on commas outside braces: `src/**\/*.{ts,tsx}, lib/*.ts` is two globs. */
function splitGlobList(text: string): string[] {
  const globs: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of text) {
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      globs.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  globs.push(current);
  return globs;
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function globsOf(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? splitGlobList(value)
      : [];
  return [...new Set(entries.map(unquote).filter(Boolean))];
}

/**
 * `paths:` read line by line — for frontmatter YAML refuses, which a glob
 * makes easy: `paths: **\/*.ts` starts with an alias marker.
 */
function globsFromLines(header: string): string[] {
  const lines = header.split(/\r?\n/);
  const index = lines.findIndex((line) => /^paths[ \t]*:/.test(line));
  if (index === -1) return [];
  const inline = lines[index]!.replace(/^paths[ \t]*:/, "").trim();
  if (inline) return globsOf(inline.replace(/^\[([\s\S]*)\]$/, "$1"));
  const items: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const item = /^[ \t]*-[ \t]*(.*)$/.exec(line);
    if (!item) break;
    items.push(item[1] ?? "");
  }
  return globsOf(items);
}

/** A rule file's globs (empty: always on) and its body. */
export function parseRule(text: string): { globs: string[]; body: string } {
  const source = text.replace(/^﻿/, "");
  const match = FRONTMATTER.exec(source);
  if (!match) return { globs: [], body: source.trim() };
  const header = match[1] ?? "";
  const body = source.slice(match[0].length).trim();
  let globs: string[];
  try {
    const parsed = parseYaml(header, { prettyErrors: false }) as unknown;
    globs =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? globsOf((parsed as Record<string, unknown>).paths)
        : [];
  } catch {
    globs = globsFromLines(header);
  }
  return { globs, body };
}

/** Does `glob` (relative to `base`, or absolute) match the file? */
function globMatches(glob: string, base: string, file: string): boolean {
  if (glob.startsWith("/")) return path.posix.matchesGlob(file, glob);
  const relative = path.posix.relative(base, file);
  if (relative === "" || relative.startsWith("..") || path.posix.isAbsolute(relative)) return false;
  return path.posix.matchesGlob(relative, glob.replace(/^\.\//, ""));
}

/** Does a rule with `paths:` apply to this file? A rule without never does here. */
export function ruleAppliesTo(rule: WorkspaceRule, file: string): boolean {
  const absolute = path.posix.resolve(file);
  return rule.globs.some((glob) => globMatches(glob, rule.base, absolute));
}

/**
 * The glob-scoped rules the given files trigger, in rule order, each with
 * the files that matched it.
 */
export function rulesForFiles(
  rules: readonly WorkspaceRule[],
  files: readonly string[],
): Array<{ rule: WorkspaceRule; files: string[] }> {
  const matches: Array<{ rule: WorkspaceRule; files: string[] }> = [];
  for (const rule of rules) {
    if (rule.globs.length === 0) continue;
    const matched = [...new Set(files.filter((file) => ruleAppliesTo(rule, file)))];
    if (matched.length > 0) matches.push({ rule, files: matched });
  }
  return matches;
}

// ── Discovery ─────────────────────────────────────────────────

function capped(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Stat, then read what the cache does not hold at the stat'ed mtime and size.
 * Returns each readable file's text by requested path.
 */
async function readTexts(
  source: WorkspaceFileSource,
  stats: FileStat[],
  skipped: WorkspaceInstructions["skipped"],
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  const toRead = new Map<string, FileStat>();
  for (const stat of stats) {
    if (!stat.exists || !stat.isFile) continue;
    const cached = textCache.get(stat.realPath);
    if (cached && cached.lastModified === stat.lastModified && cached.sizeBytes === stat.sizeBytes) {
      texts.set(stat.path, cached.text);
      continue;
    }
    if (stat.lines === null) {
      skipped.push({ path: stat.path, reason: "not a readable text file (binary, or over 1 MB)" });
      continue;
    }
    toRead.set(stat.realPath, stat);
  }
  if (toRead.size > 0) {
    const read = await source.read(
      [...toRead.values()].map((stat) => ({ path: stat.realPath, lines: stat.lines ?? 0 })),
    );
    for (const [realPath, stat] of toRead) {
      const text = read.get(realPath);
      if (text === undefined) continue;
      rememberText(realPath, { lastModified: stat.lastModified, sizeBytes: stat.sizeBytes, text });
    }
  }
  for (const stat of stats) {
    if (texts.has(stat.path) || !stat.exists || !stat.isFile) continue;
    const cached = textCache.get(stat.realPath);
    if (cached && cached.lastModified === stat.lastModified && cached.sizeBytes === stat.sizeBytes) {
      texts.set(stat.path, cached.text);
    } else if (toRead.has(stat.realPath)) {
      skipped.push({ path: stat.path, reason: "could not be read" });
    }
  }
  return texts;
}

/**
 * The instruction files and rules for a working directory. Never throws: a
 * source that cannot be reached reads as a workspace without instructions
 * (and says so in the log).
 */
export async function discoverWorkspaceInstructions(
  workingDirectory: string,
  {
    registeredRoots = [],
    source,
    worktree = null,
    maxFileChars = WORKSPACE_INSTRUCTION_FILE_MAX_CHARS,
  }: DiscoverOptions,
): Promise<WorkspaceInstructions> {
  const actualWorkingDirectory = path.posix.resolve(workingDirectory);
  // The chain is walked in the repository's terms when a worktree stands
  // in for it, then read from wherever each directory actually is.
  const logicalWorkingDirectory =
    worktree && isWithin(worktree.worktree, actualWorkingDirectory)
      ? path.posix.join(
          worktree.repository,
          path.posix.relative(worktree.worktree, actualWorkingDirectory),
        )
      : actualWorkingDirectory;
  const standIn = logicalWorkingDirectory === actualWorkingDirectory ? null : worktree;
  const root = workspaceRootFor(logicalWorkingDirectory, registeredRoots);
  const directories = directoryChain(root, logicalWorkingDirectory).map((directory) =>
    throughWorktree(directory, standIn),
  );
  const result: WorkspaceInstructions = {
    root: throughWorktree(root, standIn),
    workingDirectory: actualWorkingDirectory,
    directories,
    files: [],
    rules: [],
    skipped: [],
    worktree: standIn,
  };

  try {
    const fileCandidates = directories.flatMap((directory) =>
      INSTRUCTION_FILE_NAMES.map((name) => ({ directory, name, path: path.posix.join(directory, name) })),
    );
    const ruleFolders = directories.flatMap((directory) =>
      RULE_DIRECTORIES.map((folder) => ({ base: directory, path: path.posix.join(directory, folder) })),
    );
    const stats = await source.stat([
      ...fileCandidates.map((candidate) => candidate.path),
      ...ruleFolders.map((folder) => folder.path),
    ]);
    const statByPath = new Map(stats.map((stat) => [stat.path, stat]));

    const ruleFiles: Array<{ base: string; path: string }> = [];
    for (const folder of ruleFolders) {
      if (!statByPath.get(folder.path)?.isDirectory) continue;
      let listed: string[];
      try {
        listed = await source.listFiles(folder.path);
      } catch (error: unknown) {
        result.skipped.push({ path: folder.path, reason: `could not be listed: ${getErrorMessage(error)}` });
        continue;
      }
      const markdown = listed.filter((file) => file.toLowerCase().endsWith(".md")).sort(byteOrder);
      ruleFiles.push(...markdown.map((file) => ({ base: folder.base, path: file })));
    }
    const ruleStats = ruleFiles.length > 0 ? await source.stat(ruleFiles.map((rule) => rule.path)) : [];

    const fileStats = fileCandidates
      .map((candidate) => statByPath.get(candidate.path))
      .filter((stat): stat is FileStat => !!stat);
    const texts = await readTexts(source, [...fileStats, ...ruleStats], result.skipped);

    // One entry per text: a second file with the same words (a symlink, a
    // copy) is named under the first instead of repeated.
    const byHash = new Map<string, WorkspaceInstructionFile>();
    for (const candidate of fileCandidates) {
      const stat = statByPath.get(candidate.path);
      const text = texts.get(candidate.path)?.trim();
      if (!stat || !text) continue;
      const hash = contentHash(text);
      const earlier = byHash.get(hash);
      if (earlier) {
        earlier.sameAs.push(candidate.path);
        continue;
      }
      const { text: content, truncated } = capped(text, maxFileChars);
      const file: WorkspaceInstructionFile = {
        path: candidate.path,
        name: candidate.name,
        directory: candidate.directory,
        content,
        sameAs: [],
        truncated,
        lastModified: stat.lastModified,
      };
      byHash.set(hash, file);
      result.files.push(file);
    }

    ruleFiles.forEach((ruleFile, index) => {
      const text = texts.get(ruleFile.path);
      const stat = ruleStats[index];
      if (text === undefined || !stat) return;
      const { globs, body } = parseRule(text);
      if (!body) return;
      const { text: content, truncated } = capped(body, maxFileChars);
      result.rules.push({
        path: ruleFile.path,
        base: ruleFile.base,
        globs,
        content,
        truncated,
        lastModified: stat.lastModified,
      });
    });
  } catch (error: unknown) {
    logger.warn(
      `[WorkspaceInstructions] Could not read the instructions of ${actualWorkingDirectory}: ${getErrorMessage(error)}`,
    );
    return { ...result, files: [], rules: [] };
  }

  return result;
}
