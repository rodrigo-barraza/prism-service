/**
 * The turn boundary breakpoint (applyCacheBreakpoints #3): a client that
 * rebuilds its prompt every turn — Lupos sends each Discord message as a
 * user message and re-sends the channel's history next turn — can read that
 * history back only if a request WROTE a cache entry where the history
 * ends. The moving tail marker never does: it sits after the context the
 * assembler injects before this turn's user message, which the next turn
 * no longer carries. So the block just before the first `turnContext`
 * message gets its own marker, and the next turn's request reproduces the
 * prefix up to it byte for byte.
 */
import { describe, it, expect } from "vitest";

import { applyCacheBreakpoints, prepareMessages } from "#src/providers/anthropic";
import type { ChatMessage } from "#src/types/ProviderTypes";

type Block = { type: string; text?: string; cache_control?: unknown };
type Message = { role: string; content: string | Block[] };

const envelope = (id: number, text: string): ChatMessage =>
  ({ role: "user", content: `<discord-message id="${id}"><content>${text}</content></discord-message>` }) as ChatMessage;
const injected = (tag: string): ChatMessage =>
  ({ role: "system", content: `<${tag}>per-turn ${tag}</${tag}>`, turnContext: true }) as ChatMessage;
const respondTo = (id: number): ChatMessage =>
  ({ role: "system", content: `<respond-to id="${id}" />` }) as ChatMessage;

/** The payload's messages as sent: prepareMessages + the breakpoints. */
async function payloadMessages(messages: ChatMessage[], model = "claude-sonnet-5"): Promise<Message[]> {
  const prepared = await prepareMessages(
    [{ role: "system", content: "persona" } as ChatMessage, ...messages],
    model,
  );
  const payload: Record<string, unknown> = { system: prepared.systemMessage, messages: prepared.messages };
  applyCacheBreakpoints(payload);
  return payload.messages as Message[];
}

const blocksOf = (messages: Message[]): Block[] =>
  messages.flatMap((message) =>
    typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
  );
const marked = (messages: Message[]) => blocksOf(messages).filter((block) => block.cache_control);
/** The bytes a block puts on the wire, its cache marker aside. */
const wire = (blocks: Block[]) => JSON.stringify(blocks.map(({ cache_control: _marker, ...rest }) => rest));

const HISTORY = [envelope(1, "hi"), envelope(2, "the frozen history"), envelope(3, "ends here")];
const turnOne = [...HISTORY, injected("platform-context"), injected("system-context"), envelope(4, "@Lupos first"), respondTo(4)];
const turnTwo = [
  ...HISTORY,
  envelope(4, "@Lupos first"),
  { role: "assistant", content: "first reply" } as ChatMessage,
  envelope(5, "news"),
  injected("platform-context"),
  injected("system-context"),
  envelope(6, "@Lupos second"),
  respondTo(6),
];

describe("the turn boundary breakpoint", () => {
  for (const model of ["claude-sonnet-5", "claude-opus-5-5"]) {
    it(`marks the block before this turn's injected context, and the tail (${model})`, async () => {
      const messages = await payloadMessages(turnOne, model);
      const markedTexts = marked(messages).map((block) => block.text);
      expect(markedTexts).toHaveLength(2);
      expect(markedTexts[0]).toContain("ends here");
      expect(markedTexts[1]).toContain('<respond-to id="4"');
    });

    it(`the next turn re-sends the prefix up to that block byte for byte (${model})`, async () => {
      const first = blocksOf(await payloadMessages(turnOne, model));
      const second = blocksOf(await payloadMessages(turnTwo, model));
      const boundary = first.findIndex((block) => block.cache_control);
      expect(wire(second.slice(0, boundary + 1))).toBe(wire(first.slice(0, boundary + 1)));
      // And its own boundary sits within the 20-block lookback of that one.
      const nextBoundary = second.findIndex((block) => block.cache_control);
      expect(second[nextBoundary].text).toContain("news");
      expect(nextBoundary - boundary).toBeLessThanOrEqual(20);
    });
  }

  it("no injected context: only the moving tail marker", async () => {
    const messages = await payloadMessages([envelope(1, "hi"), envelope(2, "@Lupos")]);
    expect(marked(messages).map((block) => block.text)).toEqual([expect.stringContaining("@Lupos")]);
  });

  it("injected context first in the conversation: nothing precedes it to mark", async () => {
    const messages = await payloadMessages([injected("system-context"), envelope(1, "@Lupos")]);
    expect(marked(messages)).toHaveLength(1);
  });

  it("the tag never reaches the wire", async () => {
    const messages = await payloadMessages(turnOne);
    const sent = JSON.parse(JSON.stringify(messages)) as Message[];
    for (const block of blocksOf(sent)) {
      expect(Object.keys(block).every((key) => ["type", "text", "cache_control"].includes(key))).toBe(true);
    }
  });
});
