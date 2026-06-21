import { describe, it, expect, beforeEach } from "vitest";
import LiveFrameService from "../src/services/LiveFrameService.ts";

describe("LiveFrameService", () => {
  const firstConversationId = "conversation-id-123";
  const secondConversationId = "conversation-id-456";
  const firstFrameDataUrl = "data:image/png;base64,firstframebytes";
  const secondFrameDataUrl = "data:image/png;base64,secondframebytes";
  const thirdFrameDataUrl = "data:image/png;base64,thirdframebytes";
  const fourthFrameDataUrl = "data:image/png;base64,fourthframebytes";

  beforeEach(() => {
    LiveFrameService.clear(firstConversationId);
    LiveFrameService.clear(secondConversationId);
  });

  describe("pushFrame & getFrames", () => {
    it("should store and return pushed frames in chronological order", () => {
      LiveFrameService.pushFrame(firstConversationId, firstFrameDataUrl);
      LiveFrameService.pushFrame(firstConversationId, secondFrameDataUrl);

      const frames = LiveFrameService.getFrames(firstConversationId);
      expect(frames).toHaveLength(2);
      expect(frames[0]).toBe(firstFrameDataUrl);
      expect(frames[1]).toBe(secondFrameDataUrl);
    });

    it("should handle empty or undefined conversation ID when pushing and getting frames", () => {
      // Pushing to empty conversation ID should not throw and should be a no-op
      expect(() => {
        LiveFrameService.pushFrame("", firstFrameDataUrl);
      }).not.toThrow();

      const emptyFrames = LiveFrameService.getFrames("");
      expect(emptyFrames).toEqual([]);
    });

    it("should enforce the maximum buffer size limit of 3 frames", () => {
      LiveFrameService.pushFrame(firstConversationId, firstFrameDataUrl);
      LiveFrameService.pushFrame(firstConversationId, secondFrameDataUrl);
      LiveFrameService.pushFrame(firstConversationId, thirdFrameDataUrl);
      LiveFrameService.pushFrame(firstConversationId, fourthFrameDataUrl);

      const frames = LiveFrameService.getFrames(firstConversationId);
      expect(frames).toHaveLength(3);
      // The first frame should be evicted, keeping the last 3 in order
      expect(frames[0]).toBe(secondFrameDataUrl);
      expect(frames[1]).toBe(thirdFrameDataUrl);
      expect(frames[2]).toBe(fourthFrameDataUrl);
    });

    it("should maintain separate frame buffers for different conversations", () => {
      LiveFrameService.pushFrame(firstConversationId, firstFrameDataUrl);
      LiveFrameService.pushFrame(secondConversationId, secondFrameDataUrl);

      const firstFrames = LiveFrameService.getFrames(firstConversationId);
      const secondFrames = LiveFrameService.getFrames(secondConversationId);

      expect(firstFrames).toEqual([firstFrameDataUrl]);
      expect(secondFrames).toEqual([secondFrameDataUrl]);
    });
  });

  describe("clear", () => {
    it("should successfully remove all stored frames for a conversation", () => {
      LiveFrameService.pushFrame(firstConversationId, firstFrameDataUrl);
      LiveFrameService.pushFrame(firstConversationId, secondFrameDataUrl);

      LiveFrameService.clear(firstConversationId);

      const frames = LiveFrameService.getFrames(firstConversationId);
      expect(frames).toEqual([]);
    });

    it("should handle empty or undefined conversation ID when clearing", () => {
      expect(() => {
        LiveFrameService.clear("");
      }).not.toThrow();
    });
  });
});
