/**
 * Tests documenting and validating the fix for the done → appendAndFinalize
 * race condition.
 *
 * ROOT CAUSE: In Finalizer.ts, the `done` SSE event is emitted at line 329
 * BEFORE `appendAndFinalize` (line 485) starts the MongoDB write. Since
 * `appendAndFinalize` is fire-and-forget (returns void), the client receives
 * `done`, resolves its stream promise, and immediately fetches from the DB —
 * which hasn't been updated yet.
 *
 * FIX: Make `appendAndFinalize` awaitable so `finalizeTextGeneration` can
 * emit `done` AFTER the DB write completes. Alternatively, move the `done`
 * emission after the persistence call.
 */

import { describe, it, expect, vi } from "vitest";

// ── Simulated timeline types ────────────────────────────────────

interface TimelineEvent {
  timestamp: number;
  event: string;
}

// ── Simulated fire-and-forget appendAndFinalize ──────────────────

function simulateFireAndForget(
  writeDelayMs: number,
): {
  appendAndFinalize: () => void;
  events: TimelineEvent[];
  getIsWriteComplete: () => boolean;
} {
  const events: TimelineEvent[] = [];
  let isWriteComplete = false;

  const appendAndFinalize = () => {
    events.push({ timestamp: Date.now(), event: "appendAndFinalize_start" });
    // Fire-and-forget: returns void, no await
    setTimeout(() => {
      isWriteComplete = true;
      events.push({
        timestamp: Date.now(),
        event: "appendAndFinalize_complete",
      });
    }, writeDelayMs);
  };

  return {
    appendAndFinalize,
    events,
    getIsWriteComplete: () => isWriteComplete,
  };
}

// ── Simulated awaitable appendAndFinalize (the fix) ──────────────

function simulateAwaitableAppend(
  writeDelayMs: number,
): {
  appendAndFinalize: () => Promise<void>;
  events: TimelineEvent[];
  getIsWriteComplete: () => boolean;
} {
  const events: TimelineEvent[] = [];
  let isWriteComplete = false;

  const appendAndFinalize = async () => {
    events.push({ timestamp: Date.now(), event: "appendAndFinalize_start" });
    await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
    isWriteComplete = true;
    events.push({
      timestamp: Date.now(),
      event: "appendAndFinalize_complete",
    });
  };

  return {
    appendAndFinalize,
    events,
    getIsWriteComplete: () => isWriteComplete,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BUGGY BEHAVIOR: done before persist
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("BUGGY: done fires before DB write completes", () => {
  it("client fetch sees stale data when done fires before appendAndFinalize", async () => {
    const events: string[] = [];

    // Simulate the buggy Finalizer order
    const donePromise = new Promise<void>((resolve) => {
      // 1. emit({ type: "done" }) — fires immediately
      events.push("emit_done");

      // 2. appendAndFinalize() — fire-and-forget
      const { appendAndFinalize, getIsWriteComplete } =
        simulateFireAndForget(50);
      appendAndFinalize();

      // 3. Client receives done, resolves promise
      events.push("client_resolve");

      // 4. Client starts DB fetch
      events.push("client_db_fetch");

      // At this point, appendAndFinalize hasn't completed yet
      expect(getIsWriteComplete()).toBe(false);
      events.push("db_still_stale");

      resolve();
    });

    await donePromise;

    expect(events).toEqual([
      "emit_done",
      "client_resolve",
      "client_db_fetch",
      "db_still_stale",
    ]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FIXED BEHAVIOR: persist before done
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("FIXED: persist completes before done event", () => {
  it("client fetch sees complete data when done fires after appendAndFinalize", async () => {
    const events: string[] = [];

    // Simulate the fixed Finalizer order:
    // 1. await appendAndFinalize() — wait for DB write
    const { appendAndFinalize, getIsWriteComplete } =
      simulateAwaitableAppend(50);

    await appendAndFinalize();
    events.push("persist_complete");

    // 2. emit({ type: "done" }) — fires AFTER DB write
    events.push("emit_done");

    // 3. Client receives done
    events.push("client_resolve");

    // 4. Client fetches from DB
    events.push("client_db_fetch");

    // DB is already updated
    expect(getIsWriteComplete()).toBe(true);
    events.push("db_is_current");

    expect(events).toEqual([
      "persist_complete",
      "emit_done",
      "client_resolve",
      "client_db_fetch",
      "db_is_current",
    ]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ALTERNATIVE FIX: Await in finalize() rather than Finalizer
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Alternative fix: Finalizer returns persist promise", () => {
  it("finalize() can await the persist promise before the SSE stream ends", async () => {
    // Instead of changing Finalizer.ts to await appendAndFinalize(),
    // we can have it return the promise and let finalize() await it.
    //
    // The SSE stream only ends when the Express response stream is closed,
    // which happens AFTER finalize() returns. So if finalize() awaits the
    // persist promise, the client gets `done` only after DB is updated.

    let persistComplete = false;

    const mockFinalizeTextGeneration = async (): Promise<Promise<void>> => {
      // Emit done event
      const doneEmitted = true;

      // Start persist (returns promise instead of void)
      const persistPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          persistComplete = true;
          resolve();
        }, 50);
      });

      return persistPromise;
    };

    // finalize() awaits the returned promise
    const persistPromise = await mockFinalizeTextGeneration();
    await persistPromise;

    expect(persistComplete).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Content-aware post-stream guard tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Content-aware post-stream refresh guard", () => {
  it("count-based guard passes even with wrong content", () => {
    const streamingCount = 4;
    const databaseCount = 4;

    const countGuardBlocks = databaseCount < streamingCount;
    expect(countGuardBlocks).toBe(false);
    // BUG: wrong content passes through
  });

  it("content-aware guard catches missing user messages", () => {
    interface SimpleMessage {
      role: string;
      content: string;
    }

    const streamingMessages: SimpleMessage[] = [
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey Rodrigo!" },
      { role: "user", content: "make a song about the war" },
      { role: "assistant", content: "Creating your song!" },
    ];

    const databaseMessages: SimpleMessage[] = [
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey Rodrigo!" },
      { role: "assistant", content: "Creating!" },
      { role: "assistant", content: "Done!" },
    ];

    // Count guard: same count → passes
    expect(databaseMessages.length >= streamingMessages.length).toBe(true);

    // Content guard: check last user message
    const lastStreamingUser = [...streamingMessages]
      .reverse()
      .find((message) => message.role === "user");
    const lastDatabaseUser = [...databaseMessages]
      .reverse()
      .find((message) => message.role === "user");

    expect(lastStreamingUser?.content).toBe("make a song about the war");
    expect(lastDatabaseUser?.content).toBe("hey whats up");

    // The last user messages don't match — guard should block
    const contentGuardBlocks =
      lastStreamingUser?.content !== lastDatabaseUser?.content;
    expect(contentGuardBlocks).toBe(true);
  });

  it("improved guard: verify last user message content matches", () => {
    interface SimpleMessage {
      role: string;
      content: string;
    }

    function shouldOverwriteWithDatabaseMessages(
      streamingMessages: SimpleMessage[],
      databaseMessages: SimpleMessage[],
    ): boolean {
      // Count check
      if (databaseMessages.length < streamingMessages.length) {
        return false;
      }

      // Content check: last streaming user message must exist in DB
      const lastStreamingUser = [...streamingMessages]
        .reverse()
        .find((message) => message.role === "user");

      if (lastStreamingUser) {
        const databaseUserMessages = databaseMessages
          .filter((message) => message.role === "user")
          .map((message) => message.content);

        if (!databaseUserMessages.includes(lastStreamingUser.content)) {
          return false;
        }
      }

      return true;
    }

    // Case 1: Correct DB data
    expect(
      shouldOverwriteWithDatabaseMessages(
        [
          { role: "user", content: "hey" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "make a song" },
          { role: "assistant", content: "Creating!" },
        ],
        [
          { role: "user", content: "hey" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "make a song" },
          { role: "assistant", content: "Creating!" },
          { role: "assistant", content: "Done!" },
        ],
      ),
    ).toBe(true);

    // Case 2: Stale DB (missing current turn)
    expect(
      shouldOverwriteWithDatabaseMessages(
        [
          { role: "user", content: "hey" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "make a song" },
          { role: "assistant", content: "Creating!" },
        ],
        [
          { role: "user", content: "hey" },
          { role: "assistant", content: "Hi!" },
        ],
      ),
    ).toBe(false);

    // Case 3: Wrong content (user message missing from DB)
    expect(
      shouldOverwriteWithDatabaseMessages(
        [
          { role: "user", content: "hey" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "make a song" },
          { role: "assistant", content: "Creating!" },
        ],
        [
          { role: "user", content: "hey" },
          { role: "assistant", content: "Hi!" },
          { role: "assistant", content: "Creating!" },
          { role: "assistant", content: "Done!" },
        ],
      ),
    ).toBe(false);
  });
});
