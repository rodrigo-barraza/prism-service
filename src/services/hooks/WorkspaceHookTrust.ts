import path from "node:path";
import type { Db } from "mongodb";
import { WORKSPACE_HOOKS } from "#src/services/hooks/WorkspaceHookConstants";

/**
 * WorkspaceHookTrust — which repository hooks files a user has agreed to
 * run, and at which content.
 *
 * A hooks file in a checkout runs shell commands on the machine the
 * workspace is on, as whoever runs the bridge. Two gates stand in front of
 * it, both required (WorkspaceHooks):
 *   1. the conversation's user is in `PRISM_HOOK_COMMAND_OWNERS` — the same
 *      list that may own a stored `command` hook;
 *   2. that user trusted THAT file at THAT sha256. Codex's rule: an edited
 *      file is untrusted until it is trusted again, so a branch that
 *      rewrites the hooks does not run them on the strength of an earlier
 *      yes.
 *
 * One document per user and file (`{username, path, sha256, trustedAt}` in
 * `workspace_hook_trust`): trusting a new content replaces the old.
 */

export interface WorkspaceHookTrustDocument {
  username: string;
  path: string;
  sha256: string;
  trustedAt: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** A sha256 as the bridge writes it: 64 lowercase hex characters. */
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

/** An absolute path to a `.prism/hooks.json`. */
export function isWorkspaceHooksFilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    path.posix.isAbsolute(value) &&
    value === path.posix.normalize(value) &&
    value.endsWith(`/${WORKSPACE_HOOKS.FILE_RELATIVE_PATH}`)
  );
}

function collection(db: Db) {
  return db.collection<WorkspaceHookTrustDocument>(WORKSPACE_HOOKS.TRUST_COLLECTION);
}

/** The sha256 each of `paths` is trusted at, for one user. Absent = never trusted. */
export async function readWorkspaceHookTrust(
  db: Db,
  username: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const documents = await collection(db)
    .find({ username, path: { $in: [...new Set(paths)] } })
    .toArray();
  return new Map(documents.map((document) => [document.path, document.sha256]));
}

/** Is the file trusted at exactly this content? */
export function isTrustedAt(trust: Map<string, string>, filePath: string, sha256: string): boolean {
  return trust.get(filePath) === sha256.toLowerCase();
}

/** Trust a file at one content, replacing whatever the user trusted before. */
export async function trustWorkspaceHooksFile(
  db: Db,
  username: string,
  filePath: string,
  sha256: string,
): Promise<WorkspaceHookTrustDocument> {
  const document: WorkspaceHookTrustDocument = {
    username,
    path: filePath,
    sha256: sha256.toLowerCase(),
    trustedAt: new Date().toISOString(),
  };
  await collection(db).updateOne(
    { username, path: filePath },
    { $set: document },
    { upsert: true },
  );
  return document;
}

/** Withdraw a user's trust of a file. Returns whether there was any. */
export async function untrustWorkspaceHooksFile(
  db: Db,
  username: string,
  filePath: string,
): Promise<boolean> {
  const result = await collection(db).deleteOne({ username, path: filePath });
  return (result?.deletedCount ?? 0) > 0;
}
