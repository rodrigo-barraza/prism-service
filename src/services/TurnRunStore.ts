import type { Collection, Document } from "mongodb";
import { MONGO_DB_NAME } from "#config";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type {
  AnthropicThinkingBlock,
  ResponsesPhase,
  ResponsesReasoningItem,
} from "#src/types/admin";

/**
 * TurnRunStore — what a running turn needs to be re-driven after a restart.
 *
 * One record per root loop in `turn_runs` (id = the loop key, the
 * conversation id the client holds), written while the turn runs and
 * deleted when it ends. A record that is still here when a process starts
 * belongs to a turn that process never finished. Beside the turn checkpoint
 * (the messages so far, on the conversation document) it keeps:
 *
 *   - the REQUEST the turn was started with (minus its messages), so the
 *     re-driven turn resolves provider, model, options and tools exactly as
 *     the first one did — and the system prompt it assembled;
 *   - the loop state a checkpoint does not carry: iteration, plan mode,
 *     a mid-turn "approve all";
 *   - the PASS whose tool batch was in progress: what the model said
 *     (text, thinking, provider-native state) and the calls it made, with
 *     each call's progress — running, or finished with its result.
 *
 * A pass belongs to the checkpoint iteration it was made in. The next
 * iteration's checkpoint already carries that pass's messages, so a pass
 * older than the conversation's checkpoint is spent and never replayed
 * (TurnResumeService compares the two).
 *
 * Root loops only: a sub-agent is not re-driven on its own (its parent is
 * told it was interrupted — DetachedWorkRecovery). Without a connected
 * database nothing is recorded, which is exactly what a restart would find.
 */

export interface StoredToolCall {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  responsesItemId?: string;
  thoughtSignature?: string;
  reasoningItem?: ResponsesReasoningItem;
}

export type StoredCallStatus = "running" | "finished";

export interface StoredCallState {
  status: StoredCallStatus;
  startedAt: string;
  finishedAt?: string;
  /** The result the loop acted on (after its PostToolUse hooks). */
  result?: unknown;
  /** The result was too large (or not serializable) to keep: the call re-runs or is asked about. */
  resultOmitted?: boolean;
  durationMilliseconds?: number;
}

/** A model pass whose tool batch was in progress — enough to replay it verbatim. */
export interface StoredPass {
  iteration: number;
  /** The pass's raw streamed text. */
  text: string;
  thinking: string;
  thinkingSignature?: string;
  thinkingBlocks?: AnthropicThinkingBlock[];
  phase?: ResponsesPhase;
  reasoningItems?: ResponsesReasoningItem[];
  providerResponseId?: string;
  toolCalls: StoredToolCall[];
  /** Each call's progress, by its index in `toolCalls`. */
  calls: Record<string, StoredCallState>;
}

export interface TurnRunRecord {
  /** The loop key: a root turn's conversation id. */
  id: string;
  /** The turn this record belongs to (its request id) — a later turn of the loop replaces it. */
  turnId: string;
  conversationId: string;
  agentConversationId: string;
  /** Collection of the conversation document (and its turn checkpoint). */
  conversationCollection: string;
  project: string;
  username: string;
  profileId?: string | null;
  agent?: string | null;
  /** The handleAgent params the turn started from, without `messages`. */
  request: Record<string, unknown>;
  systemPrompt?: string | null;
  skillsText?: string | null;
  conversationMeta?: Record<string, unknown> | null;
  /** The iteration of the latest checkpoint. */
  iteration: number;
  planModeActive: boolean;
  autoApprove: boolean;
  pass?: StoredPass | null;
  /** `pass.iteration`, top-level so a call's progress can only land on its own pass. */
  passIteration?: number | null;
  /** How many processes have re-driven this turn. */
  attempts: number;
  startedAt: string;
  updatedAt: string;
}

export type TurnRunStart = Omit<
  TurnRunRecord,
  "attempts" | "startedAt" | "updatedAt" | "pass" | "passIteration"
>;

function collection(): Collection<Document> | null {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME)?.collection(COLLECTIONS.TURN_RUNS) ?? null;
  } catch {
    return null; // not connected (unit tests, a degraded boot)
  }
}

function stripMongoId(document: Document): TurnRunRecord {
  const { _id: _ignored, ...record } = document;
  return record as TurnRunRecord;
}

async function write(
  label: string,
  operation: (runs: Collection<Document>) => Promise<unknown>,
): Promise<void> {
  const runs = collection();
  if (!runs) return;
  try {
    await operation(runs);
  } catch (error: unknown) {
    // Best-effort: a failed write costs resumability, never the turn.
    logger.warn(`[TurnRunStore] ${label} failed: ${getErrorMessage(error)}`);
  }
}

const TurnRunStore = {
  /**
   * The turn's first checkpoint. A fresh turn replaces whatever an earlier
   * turn of the loop left; a re-driven one keeps the pass it is replaying
   * and its attempt count.
   */
  async begin(start: TurnRunStart, { resumed = false }: { resumed?: boolean } = {}): Promise<void> {
    const now = new Date().toISOString();
    await write(`begin ${start.id}`, (runs) =>
      resumed
        ? runs.updateOne({ id: start.id }, { $set: { ...start, updatedAt: now } })
        : runs.updateOne(
            { id: start.id },
            {
              $set: { ...start, attempts: 0, startedAt: now, updatedAt: now },
              $unset: { pass: "", passIteration: "" },
            },
            { upsert: true },
          ),
    );
  },

  /** A later checkpoint of the same turn. */
  async checkpoint(
    id: string,
    turnId: string,
    fields: { iteration: number; planModeActive: boolean; autoApprove: boolean },
  ): Promise<void> {
    await write(`checkpoint ${id}`, (runs) =>
      runs.updateOne(
        { id, turnId },
        { $set: { ...fields, updatedAt: new Date().toISOString() } },
      ),
    );
  },

  /** The model asked for tools: record the pass before any of them is asked about or run. */
  async recordPass(id: string, turnId: string, pass: StoredPass): Promise<void> {
    await write(`pass ${id}#${pass.iteration}`, (runs) =>
      runs.updateOne(
        { id, turnId },
        {
          $set: { pass, passIteration: pass.iteration, updatedAt: new Date().toISOString() },
        },
      ),
    );
  },

  /** One call's progress — only onto the pass it belongs to. */
  async recordCall(
    id: string,
    turnId: string,
    iteration: number,
    index: number,
    state: StoredCallState,
  ): Promise<void> {
    await write(`call ${id}#${iteration}.${index}`, (runs) =>
      runs.updateOne(
        { id, turnId, passIteration: iteration },
        { $set: { [`pass.calls.${index}`]: state, updatedAt: new Date().toISOString() } },
      ),
    );
  },

  /** The turn ended (finished, failed, stopped): nothing is left to re-drive. */
  async finish(id: string, turnId: string): Promise<void> {
    await write(`finish ${id}`, (runs) => runs.deleteOne({ id, turnId }));
  },

  /** Drop a record whatever turn it belongs to (it will not be re-driven). */
  async discard(id: string): Promise<void> {
    await write(`discard ${id}`, (runs) => runs.deleteOne({ id }));
  },

  /** Count one more re-drive of this turn; returns the record as it now stands. */
  async claim(id: string): Promise<TurnRunRecord | null> {
    const runs = collection();
    if (!runs) return null;
    try {
      await runs.updateOne(
        { id },
        { $inc: { attempts: 1 }, $set: { updatedAt: new Date().toISOString() } },
      );
      const document = await runs.findOne({ id });
      return document ? stripMongoId(document) : null;
    } catch (error: unknown) {
      logger.warn(`[TurnRunStore] claim ${id} failed: ${getErrorMessage(error)}`);
      return null;
    }
  },

  /** Every record — at boot, the turns the previous process left unfinished. */
  async listAll(): Promise<TurnRunRecord[]> {
    const runs = collection();
    if (!runs) return [];
    try {
      return (await runs.find({}).toArray()).map(stripMongoId);
    } catch (error: unknown) {
      logger.error(`[TurnRunStore] Could not list turn runs: ${getErrorMessage(error)}`);
      return [];
    }
  },

  async get(id: string): Promise<TurnRunRecord | null> {
    const runs = collection();
    if (!runs) return null;
    const document = await runs.findOne({ id });
    return document ? stripMongoId(document) : null;
  },
};

export default TurnRunStore;
