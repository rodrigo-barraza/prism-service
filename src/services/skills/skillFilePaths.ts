// ────────────────────────────────────────────────────────────
// skillFilePaths — the one path rule inside a skill folder
// ────────────────────────────────────────────────────────────
// A path names a file INSIDE a folder: relative, `/`-separated, with no
// `..` segment and no absolute spelling on any platform (`/x`, `\\host`,
// `C:`, `~`). `.` segments, repeated separators and backslashes are
// normalized away. read_skill_file, the zip reader and the folder store
// all go through it, so a folder's keys and its manifest agree.
// ────────────────────────────────────────────────────────────

export const SKILL_FILE_PATH_MAX_CHARS = 512;

export function normalizeSkillFilePath(input: unknown): { path: string } | { error: string } {
  if (typeof input !== "string") return { error: "path must be a string" };
  const trimmed = input.trim();
  if (trimmed.length > SKILL_FILE_PATH_MAX_CHARS) {
    return { error: `path is too long (over ${SKILL_FILE_PATH_MAX_CHARS} characters)` };
  }
  if (trimmed.includes("\u0000")) return { error: "path contains a NUL byte" };
  if (/^[\\/]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed) || /^~(?:$|[\\/])/.test(trimmed)) {
    return {
      error: `"${trimmed}" is an absolute path; name a file inside the skill folder, e.g. scripts/run.sh`,
    };
  }
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    return { error: `"${trimmed}" leaves the skill folder ("..")` };
  }
  if (segments.length === 0) return { error: "path is required" };
  return { path: segments.join("/") };
}
