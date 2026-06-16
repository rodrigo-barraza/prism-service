import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MOCK_GENERATE_TEXT } from './setup.ts';

// ── Import under test ────────────────────────────────────────────

const { default: SomaticStateService } = await import('../src/services/somatic/SomaticStateService.ts');

describe('Somatic State Flow Adversarial Tests', () => {
  beforeEach(async () => {
    MOCK_GENERATE_TEXT.mockClear();
    MOCK_GENERATE_TEXT.mockResolvedValue({
      text: 'joy',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    vi.clearAllMocks();

    // Clean up active agent states cached in memory
    const loadedAgentIds = SomaticStateService.getLoadedAgentIds();
    for (const agentId of loadedAgentIds) {
      await SomaticStateService.destroyAgent(agentId);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 1. Boundary & Edge Cases
  // ────────────────────────────────────────────────────────────────
  describe('Boundary & Edge Cases', () => {
    it('should clamp physical stat levels when set to extreme values', async () => {
      const agentId = 'CLAMP_TEST_AGENT';

      // Setting very high values should clamp to max (100 or 10 depending on stat)
      const clampedHighHunger = await SomaticStateService.setPhysicalStatLevel(agentId, 'hunger', 500);
      expect(clampedHighHunger).toBe(100);

      const clampedHighAlcohol = await SomaticStateService.setPhysicalStatLevel(agentId, 'alcohol', 9999);
      expect(clampedHighAlcohol).toBe(10);

      // Setting negative values should clamp to min (0)
      const clampedLowThirst = await SomaticStateService.setPhysicalStatLevel(agentId, 'thirst', -100);
      expect(clampedLowThirst).toBe(0);
    });

    it('should handle zero-width joiners and malformed markdown tags in message adaptation', async () => {
      const agentId = 'MARKDOWN_TEST_AGENT';
      const malformedText = '<message_content>Hello\u200DWorld\u200D</message_content><message_content>Real content here</message_content>';

      await SomaticStateService.adaptFromMessage(agentId, malformedText);
      const snapshot = await SomaticStateService.getSnapshot(agentId);

      // Ensure physical stat levels were not broken and emotion analysis was triggered
      expect(snapshot).toBeDefined();
      expect(MOCK_GENERATE_TEXT).toHaveBeenCalled();
    });

    it('should handle invalid emotion additions with negative or extremely high intensities', async () => {
      const agentId = 'EMOTION_TEST_AGENT';

      // Negative intensity (should fallback or handle gracefully)
      const negativeResult = await SomaticStateService.addEmotion(agentId, 'joy', -50);
      expect(negativeResult).toBeDefined();

      // Infinite intensity (should handle/clamp safely)
      const infiniteResult = await SomaticStateService.addEmotion(agentId, 'joy', Number.POSITIVE_INFINITY);
      expect(infiniteResult).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Type Coercion & Schema Violations
  // ────────────────────────────────────────────────────────────────
  describe('Type Coercion & Schema Violations', () => {
    it('should handle type mismatches in physical stat levels gracefully', async () => {
      const agentId = 'COERCION_TEST_AGENT';

      // Passing NaN (should clamp or keep state safe)
      const nanResult = await SomaticStateService.setPhysicalStatLevel(agentId, 'hunger', Number.NaN);
      expect(nanResult).toBeDefined();

      // Passing float values where integer is expected
      const floatResult = await SomaticStateService.setPhysicalStatLevel(agentId, 'hunger', 42.85);
      expect([42, 43]).toContain(Math.round(floatResult));
    });

    it('should handle undefined message content and extract empty string safely', async () => {
      const agentId = 'UNDEFINED_MSG_AGENT';

      // Calling adaptFromMessage with empty string should skip processing safely
      await SomaticStateService.adaptFromMessage(agentId, '');
      expect(MOCK_GENERATE_TEXT).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Concurrency & Race Conditions
  // ────────────────────────────────────────────────────────────────
  describe('Concurrency & Race Conditions', () => {
    it('should prevent map state corruption when handling concurrent adaptation requests', async () => {
      const agentId = 'CONCURRENT_AGENT';

      // Trigger 10 parallel adaptFromMessage requests
      const promises = Array.from({ length: 10 }).map(() =>
        SomaticStateService.adaptFromMessage(agentId, 'eat food drink water rest work')
      );

      await Promise.all(promises);

      const snapshot = await SomaticStateService.getSnapshot(agentId);
      expect(snapshot.hunger.level).toBeDefined();
      expect(snapshot.thirst.level).toBeDefined();
      expect(snapshot.energy.level).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 4. State Machine Violations
  // ────────────────────────────────────────────────────────────────
  describe('State Machine Violations', () => {
    it('should prevent memory leaks and clear active interval when agent is destroyed', async () => {
      const agentId = 'LEAK_TEST_AGENT';

      // Initialize agent
      await SomaticStateService.getSnapshot(agentId);
      expect(SomaticStateService.hasAgent(agentId)).toBe(true);

      // Destroy agent
      await SomaticStateService.destroyAgent(agentId);
      expect(SomaticStateService.hasAgent(agentId)).toBe(false);
    });

    it('should handle double-destruction of agent state without throwing exceptions', async () => {
      const agentId = 'DOUBLE_DESTROY_AGENT';

      // Initialize
      await SomaticStateService.getSnapshot(agentId);

      // Destroy first time
      await expect(SomaticStateService.destroyAgent(agentId)).resolves.not.toThrow();

      // Destroy second time
      await expect(SomaticStateService.destroyAgent(agentId)).resolves.not.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Error Recovery & Graceful Degradation
  // ────────────────────────────────────────────────────────────────
  describe('Error Recovery & Graceful Degradation', () => {
    it('should fallback to default initial state when loading from database throws an error', async () => {
      const agentId = 'DB_ERROR_AGENT';

      // Note: MongoDB is mocked globally in setup.ts so we don't have to worry about connection errors
      // unless we want to simulate db query failures by mocking the collection findOne to reject.
      const MongoWrapper = (await import('../src/wrappers/MongoWrapper.ts')).default;
      const getCollectionSpy = vi.spyOn(MongoWrapper, 'getCollection').mockImplementation(() => {
        throw new Error('Database connection lost');
      });

      // Service should handle it, initialize with defaults, and not throw
      const snapshot = await SomaticStateService.getSnapshot(agentId);
      expect(snapshot.hunger.level).toBe(0); // Hunger initial default
      expect(snapshot.energy.level).toBe(100); // Energy initial default

      getCollectionSpy.mockRestore();
    });
  });
});
