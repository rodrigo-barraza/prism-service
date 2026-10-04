/**
 * Restore Image-Only Replies
 *
 * Until branch keep-image-only-replies, the Finalizer dropped an assistant
 * reply with no text and no tool calls as an "empty stub" — including a
 * reply that was only an image (Gemini image models answer that way). The
 * chat showed the image while it streamed; the stored conversation kept
 * only the user's prompt. The image itself was uploaded and its request row
 * kept the ref (`requests.responsePayload.images`), so the reply can be put
 * back where it belongs: right after the user message it answered.
 *
 * Dry run by default — prints what it would insert. `--apply` writes.
 * Only /chat rows are restored (operation "chat"); an agent turn's lost
 * image has no single place in its transcript to return to.
 *
 * A conversation is written only if it is not generating and its
 * `updatedAt` is unchanged since it was read. `updatedAt` is not bumped,
 * so a restored conversation keeps its place in the list.
 *
 * Usage:
 *   node scripts/restore-image-only-replies.ts            # dry run
 *   node scripts/restore-image-only-replies.ts --apply
 *   node scripts/restore-image-only-replies.ts --project prism-client --apply
 *
 * Environment:
 *   MONGO_URI (or PRISM_SERVICE_MONGO_URI) — MongoDB connection string
 *   MONGO_DB_NAME (or PRISM_MONGO_DB_NAME) — database name (default: "prism")
 *   MINIO_PUBLIC_URL + MINIO_BUCKET_NAME — optional: each image is checked
 *     with a HEAD request first, and a reply whose image is gone is skipped
 */

import { randomUUID } from "node:crypto";
import { connectDatabase, getDatabase, disconnectDatabase } from "@rodrigo-barraza/utilities-library/service/mongo";
import { computeModalities } from "../src/services/conversation/utils.ts";
import type { ChatMessage } from "../src/types/admin.ts";
import type { Db, Document } from "mongodb";

const MONGO_URI =
  process.env.PRISM_SERVICE_MONGO_URI ||
  process.env.PRISM_MONGO_URI ||
  process.env.MONGO_URI ||
  "";

const MONGO_DB_NAME =
  process.env.PRISM_SERVICE_MONGO_DB_NAME ||
  process.env.PRISM_MONGO_DB_NAME ||
  process.env.MONGO_DB_NAME ||
  "prism";

const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL || "";
const MINIO_BUCKET_NAME =
  process.env.PRISM_SERVICE_MINIO_BUCKET_NAME ||
  process.env.PRISM_MINIO_BUCKET_NAME ||
  process.env.MINIO_BUCKET_NAME ||
  "";

const CONVERSATION_COLLECTIONS = ["model_conversations", "agent_conversations"];

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const projectFlag = argv.indexOf("--project");
const PROJECT = projectFlag >= 0 ? argv[projectFlag + 1] : null;

interface LostReply {
  requestId: string;
  conversationId: string;
  project: string;
  createdAt: string;
  prompt: string;
  images: string[];
  thinking: string;
}

interface StoredMessage extends Document {
  role: string;
  content?: unknown;
  rawContent?: unknown;
  images?: unknown[];
  timestamp?: string;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The prompt a /chat request answered: its last user message's text. */
function promptOf(requestMessages: StoredMessage[] | undefined): string {
  const lastUser = [...(requestMessages || [])].reverse().find((message) => message.role === "user");
  return textOf(lastUser?.rawContent) || textOf(lastUser?.content);
}

/** Every image-only /chat reply logged in the requests collection. */
async function findImageOnlyReplies(database: Db): Promise<LostReply[]> {
  const rows = await database
    .collection("requests")
    .find(
      {
        operation: "chat",
        conversationId: { $nin: [null, ""] },
        "responsePayload.images.0": { $exists: true },
        ...(PROJECT && { project: PROJECT }),
      },
      {
        projection: {
          requestId: 1,
          conversationId: 1,
          project: 1,
          createdAt: 1,
          "requestPayload.messages": 1,
          "responsePayload.text": 1,
          "responsePayload.thinking": 1,
          "responsePayload.images": 1,
        },
      },
    )
    .sort({ createdAt: 1 })
    .toArray();
  return rows
    .filter((row) => !textOf(row.responsePayload?.text).trim())
    .map((row) => ({
      requestId: row.requestId,
      conversationId: row.conversationId,
      project: row.project,
      createdAt: new Date(row.createdAt).toISOString(),
      prompt: promptOf(row.requestPayload?.messages),
      images: (row.responsePayload.images as unknown[]).filter(
        (image): image is string => typeof image === "string",
      ),
      thinking: textOf(row.responsePayload?.thinking),
    }));
}

/**
 * A user message the client sent without a timestamp is stamped at
 * finalize, milliseconds AFTER its request row was logged (every Lupos
 * tool call to /chat). Nobody sends the same prompt again this soon after
 * its reply.
 */
const SERVER_STAMP_SLACK_MILLISECONDS = 5_000;

/**
 * Where a reply goes back: after the newest user message, sent before the
 * reply was logged, that carries the request's prompt and that no
 * assistant message answers yet. -1 when there is none (edited or deleted).
 */
function answeredUserIndex(messages: StoredMessage[], reply: LostReply): number {
  const latestPromptTime = Date.parse(reply.createdAt) + SERVER_STAMP_SLACK_MILLISECONDS;
  let found = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = textOf(message.content);
    const raw = textOf(message.rawContent);
    if (reply.prompt !== text && reply.prompt !== raw) continue;
    if (messages[index + 1]?.role === "assistant") continue;
    if (message.timestamp && Date.parse(message.timestamp) > latestPromptTime) continue;
    found = index;
  }
  return found;
}

async function imageIsStored(reference: string): Promise<boolean | null> {
  if (!MINIO_PUBLIC_URL || !MINIO_BUCKET_NAME || !reference.startsWith("minio://")) return null;
  const key = reference.slice("minio://".length);
  const url = `${MINIO_PUBLIC_URL.replace(/\/+$/, "")}/${MINIO_BUCKET_NAME}/${key}`;
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!MONGO_URI) {
    console.error("MONGO_URI environment variable is required");
    process.exit(1);
  }
  await connectDatabase(MONGO_URI, { name: MONGO_DB_NAME, dbName: MONGO_DB_NAME });
  const database = getDatabase(MONGO_DB_NAME);
  if (!database) {
    console.error("Failed to get database instance");
    process.exit(1);
  }
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — database ${MONGO_DB_NAME}${PROJECT ? `, project ${PROJECT}` : ""}`);
  if (!MINIO_PUBLIC_URL || !MINIO_BUCKET_NAME) {
    console.log("MINIO_PUBLIC_URL / MINIO_BUCKET_NAME unset — images are not checked before restoring");
  }

  const replies = await findImageOnlyReplies(database);
  const byConversation = new Map<string, LostReply[]>();
  for (const reply of replies) {
    const list = byConversation.get(reply.conversationId) || [];
    list.push(reply);
    byConversation.set(reply.conversationId, list);
  }

  const totals = { restored: 0, conversations: 0, alreadyStored: 0, unmatched: 0, imageGone: 0, busy: 0 };
  for (const [conversationId, conversationReplies] of byConversation) {
    let collectionName = "";
    let conversation: Document | null = null;
    for (const name of CONVERSATION_COLLECTIONS) {
      conversation = await database.collection(name).findOne({ id: conversationId });
      if (conversation) {
        collectionName = name;
        break;
      }
    }
    if (!conversation) {
      totals.unmatched += conversationReplies.length;
      console.log(`- ${conversationId}: no conversation document — skipped`);
      continue;
    }

    const messages = [...((conversation.messages as StoredMessage[]) || [])];
    const storedImages = new Set(
      messages.filter((message) => message.role === "assistant").flatMap((message) => message.images || []),
    );
    const inserted: string[] = [];
    for (const reply of conversationReplies) {
      if (reply.images.every((image) => storedImages.has(image))) {
        totals.alreadyStored++;
        continue;
      }
      const checks = await Promise.all(reply.images.map(imageIsStored));
      if (checks.some((check) => check === false)) {
        totals.imageGone++;
        console.log(`- ${conversationId}: image of ${reply.requestId} is gone from storage — skipped`);
        continue;
      }
      const userIndex = answeredUserIndex(messages, reply);
      if (userIndex < 0) {
        totals.unmatched++;
        console.log(`- ${conversationId}: no unanswered prompt matches ${reply.requestId} — skipped`);
        continue;
      }
      messages.splice(userIndex + 1, 0, {
        role: "assistant",
        content: "",
        ...(reply.thinking && { thinking: reply.thinking }),
        images: reply.images,
        timestamp: reply.createdAt,
        requestId: reply.requestId,
        id: `msg_${randomUUID()}`,
      });
      reply.images.forEach((image) => storedImages.add(image));
      inserted.push(`after message ${userIndex}: ${reply.images.join(", ")}`);
    }
    if (inserted.length === 0) continue;

    console.log(
      `${conversationId} (${collectionName}, ${conversation.project}/${conversation.username}) "${String(conversation.title || "").slice(0, 60)}"`,
    );
    for (const line of inserted) console.log(`    + ${line}`);
    if (!APPLY) {
      totals.restored += inserted.length;
      totals.conversations++;
      continue;
    }
    if (conversation.isGenerating === true) {
      totals.busy += inserted.length;
      console.log("    ! generating right now — skipped, run again later");
      continue;
    }
    const result = await database.collection(collectionName).updateOne(
      { _id: conversation._id, updatedAt: conversation.updatedAt, isGenerating: { $ne: true } },
      {
        $set: {
          messages,
          messageCount: messages.length,
          modalities: computeModalities(messages as unknown as ChatMessage[]),
        },
      },
    );
    if (result.modifiedCount === 1) {
      totals.restored += inserted.length;
      totals.conversations++;
    } else {
      totals.busy += inserted.length;
      console.log("    ! changed while restoring — skipped, run again");
    }
  }

  console.log(
    `\n${APPLY ? "Restored" : "Would restore"} ${totals.restored} repl${totals.restored === 1 ? "y" : "ies"} in ${totals.conversations} conversation(s)` +
      ` · already stored ${totals.alreadyStored} · unmatched ${totals.unmatched}` +
      ` · image gone ${totals.imageGone} · busy ${totals.busy}`,
  );
  await disconnectDatabase(MONGO_DB_NAME);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
