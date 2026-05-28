import logger from "../utils/logger.ts";

export default class LiveFrameService {
  // Map of agentSessionId -> array of base64 frames (oldest to newest)
  private static readonly frameBuffers = new Map<string, string[]>();
  private static readonly MAX_FRAME_COUNT = 3;

  /** Push a new frame into the rolling buffer for a session. */
  static pushFrame(agentSessionId: string, frameDataUrl: string): void {
    if (!agentSessionId) return;

    let frameBuffer = this.frameBuffers.get(agentSessionId);
    if (!frameBuffer) {
      frameBuffer = [];
      this.frameBuffers.set(agentSessionId, frameBuffer);
    }

    frameBuffer.push(frameDataUrl);

    // Keep only the last N frames
    if (frameBuffer.length > this.MAX_FRAME_COUNT) {
      frameBuffer.shift();
    }
  }

  /** Get the current frames for a session. */
  static getFrames(agentSessionId: string): string[] {
    if (!agentSessionId) return [];
    return this.frameBuffers.get(agentSessionId) || [];
  }

  /** Clear the buffer for a session. */
  static clear(agentSessionId: string): void {
    if (!agentSessionId) return;
    this.frameBuffers.delete(agentSessionId);
  }
}
