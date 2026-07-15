import { describe, it, expect } from 'vitest';
import { EmotionalStateEngine } from '#src/services/somatic/EmotionalStateEngine';
import { PRIMARY_EMOTIONS } from '#src/services/somatic/SomaticConstants';

describe('EmotionalStateEngine Unit Tests', () => {
  it('should initialize with default emotions at 0 when no baseline is set', () => {
    const engine = new EmotionalStateEngine();
    const values = engine.getEmotionValues();

    for (const emotion of PRIMARY_EMOTIONS) {
      expect(values[emotion]).toBe(0);
    }
  });

  it('should initialize at the personality baseline levels', () => {
    const engine = new EmotionalStateEngine({
      baselineLevels: { disgust: 30, anticipation: 34, joy: 20 },
    });

    expect(engine.emotions.disgust).toBe(30);
    expect(engine.emotions.anticipation).toBe(34);
    expect(engine.emotions.joy).toBe(20);
    expect(engine.emotions.fear).toBe(0);
  });

  it('should apply personality overrides in the constructor', () => {
    const engine = new EmotionalStateEngine({
      sensitivity: 1.5,
      volatility: 2.0,
    });

    expect(engine.personality.sensitivity).toBe(1.5);
    expect(engine.personality.volatility).toBe(2.0);
  });

  it('should accurately set and retrieve emotion values', () => {
    const engine = new EmotionalStateEngine();
    engine.setEmotion('joy', 50);
    engine.setEmotion('joy', 150); // should clamp to 100
    engine.setEmotion('fear', -10); // should clamp to 0

    expect(engine.emotions.joy).toBe(100);
    expect(engine.emotions.fear).toBe(0);
  });

  it('should reset all emotions to baseline', () => {
    const engine = new EmotionalStateEngine({
      baselineLevels: { anger: 26 },
    });
    engine.setEmotion('joy', 50);
    engine.setEmotion('anger', 80);
    engine.reset();

    expect(engine.emotions.joy).toBe(0);
    expect(engine.emotions.anger).toBe(26);
  });

  it('should decay deviations toward baseline with a half-life', () => {
    const engine = new EmotionalStateEngine({
      baselineLevels: { joy: 20 },
      decayHalfLifeMinutes: 60,
    });

    engine.setEmotion('joy', 80);
    engine.decay(60); // exactly one half-life

    // deviation 60 halves to 30 → 20 + 30 = 50
    expect(engine.emotions.joy).toBeCloseTo(50, 5);

    engine.decay(60);
    expect(engine.emotions.joy).toBeCloseTo(35, 5);
  });

  it('should decay upward when below baseline', () => {
    const engine = new EmotionalStateEngine({
      baselineLevels: { anticipation: 40 },
      decayHalfLifeMinutes: 60,
    });

    engine.setEmotion('anticipation', 0);
    engine.decay(60);

    // deviation -40 halves to -20 → 40 - 20 = 20
    expect(engine.emotions.anticipation).toBeCloseTo(20, 5);
  });

  it('should snap tiny residual deviations exactly to baseline', () => {
    const engine = new EmotionalStateEngine({
      baselineLevels: { joy: 20 },
      decayHalfLifeMinutes: 1,
    });

    engine.setEmotion('joy', 21);
    engine.decay(600); // many half-lives

    expect(engine.emotions.joy).toBe(20);
  });

  it('should not decay when decayHalfLifeMinutes is disabled', () => {
    const engine = new EmotionalStateEngine({
      decayHalfLifeMinutes: 0,
    });

    engine.setEmotion('joy', 80);
    engine.decay(600);

    expect(engine.emotions.joy).toBe(80);
  });

  it('should ignore invalid elapsed durations', () => {
    const engine = new EmotionalStateEngine({
      decayHalfLifeMinutes: 60,
    });

    engine.setEmotion('joy', 80);
    engine.decay(0);
    engine.decay(-5);
    engine.decay(Number.NaN);

    expect(engine.emotions.joy).toBe(80);
  });

  it('should shift emotions through addEmotion', () => {
    const engine = new EmotionalStateEngine();

    engine.setEmotion('joy', 80);
    const valueBefore = engine.emotions.joy;

    engine.addEmotion('sadness', 40);
    expect(engine.emotions.joy).toBeLessThan(valueBefore);
  });

  it('should add emotions adjusting for personality thresholds', () => {
    const engine = new EmotionalStateEngine({
      sensitivity: 0.8,
      volatility: 1.2,
      emotionalInertia: 0.0,
    });

    engine.addEmotion('anger', 50);
    // adjustedIntensity = 50 * 0.8 * 1.2 * 1.0 = 48
    // actualGain = 48 * (100/100) = 48
    expect(engine.emotions.anger).toBe(48);
  });

  it('should apply emotional inertia based on dominant emotion', () => {
    const engine = new EmotionalStateEngine({
      sensitivity: 1.0,
      volatility: 1.0,
      emotionalInertia: 0.5,
      threshold: 10,
    });

    engine.setEmotion('joy', 80);
    // dominant emotion is joy (80 > 10)
    engine.addEmotion('anger', 50);

    // inertiaFactor = 1 - 0.5 * (80 / 100) = 1 - 0.4 = 0.6
    // adjustedIntensity = 50 * 1 * 1 * 0.6 = 30
    expect(engine.emotions.anger).toBe(30);
  });

  it('should reduce opposite emotion when adding an emotion', () => {
    const engine = new EmotionalStateEngine({
      sensitivity: 1.0,
      volatility: 1.0,
      emotionalInertia: 0.0,
    });

    engine.setEmotion('sadness', 60); // opposite of joy
    engine.addEmotion('joy', 40);

    // joy gain = 40 * (100/100) = 40
    // opposite (sadness) reduction = 60 - 40 * 0.5 = 40
    expect(engine.emotions.joy).toBe(40);
    expect(engine.emotions.sadness).toBe(40);
  });

  it('should calculate dominant emotions including neutral state', () => {
    const engine = new EmotionalStateEngine({
      threshold: 10,
    });

    // All are 0 (< threshold) -> neutral
    let dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe('neutral');
    expect(dominant.intensity).toBe(0);

    engine.setEmotion('joy', 25);
    dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe('joy');
    expect(dominant.intensity).toBe(25);
  });

  it('should calculate Plutchik dyads when top emotions are close', () => {
    const engine = new EmotionalStateEngine({
      threshold: 10,
      dyadThreshold: 0.8,
    });

    // Joy + Trust = Love dyad
    engine.setEmotion('joy', 80);
    engine.setEmotion('trust', 75);

    const dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe('love'); // "joy+trust" sorted is joy+trust -> love
    expect(dominant.isDyad).toBe(true);
    expect(dominant.intensity).toBe(77.5);
    expect(dominant.components).toContain('joy');
    expect(dominant.components).toContain('trust');
  });

  it('should accumulate emotions through repeated addEmotion calls', () => {
    const engine = new EmotionalStateEngine({
      sensitivity: 1.0,
      volatility: 1.0,
      emotionalInertia: 0.0,
      threshold: 5,
    });

    engine.addEmotion('joy', 30);
    const firstValue = engine.emotions.joy;
    expect(firstValue).toBeGreaterThan(0);

    engine.addEmotion('joy', 30);
    expect(engine.emotions.joy).toBeGreaterThan(firstValue);

    const dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe('joy');
  });

  it('should serialize and deserialize engine state accurately', () => {
    const engine = new EmotionalStateEngine();
    engine.setEmotion('joy', 65);
    engine.setEmotion('anger', 40);

    const serialized = engine.serialize();
    expect(serialized.emotions.joy).toBe(65);
    expect(serialized.emotions.anger).toBe(40);

    const deserialized = EmotionalStateEngine.deserialize(serialized);
    expect(deserialized.emotions.joy).toBe(65);
    expect(deserialized.emotions.anger).toBe(40);
  });

  it('should apply personality overrides during deserialize', () => {
    const engine = new EmotionalStateEngine();
    engine.setEmotion('joy', 65);

    const deserialized = EmotionalStateEngine.deserialize(engine.serialize(), {
      baselineLevels: { joy: 20 },
      decayHalfLifeMinutes: 60,
    });

    expect(deserialized.emotions.joy).toBe(65);
    deserialized.decay(60);
    expect(deserialized.emotions.joy).toBeCloseTo(42.5, 5);
  });
});
