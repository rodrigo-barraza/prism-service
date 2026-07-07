import { describe, it, expect } from 'vitest';
import { EmotionalStateEngine } from '../EmotionalStateEngine.ts';
import { PRIMARY_EMOTIONS } from '../SomaticConstants.ts';

describe('EmotionalStateEngine Unit Tests', () => {
  it('should initialize with default emotions at 0', () => {
    const engine = new EmotionalStateEngine();
    const values = engine.getEmotionValues();

    for (const emotion of PRIMARY_EMOTIONS) {
      expect(values[emotion]).toBe(0);
    }
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

  it('should reset all emotions to 0', () => {
    const engine = new EmotionalStateEngine();
    engine.setEmotion('joy', 50);
    engine.setEmotion('anger', 80);
    engine.reset();

    const values = engine.getEmotionValues();
    for (const emotion of PRIMARY_EMOTIONS) {
      expect(values[emotion]).toBe(0);
    }
  });

  it('should decay emotions over time in decay mode', () => {
    const engine = new EmotionalStateEngine({
      emotionalModel: 'decay',
      decayRate: 0.1,
      linearDecay: 1.0,
      zeroClamp: 0.5,
    });

    engine.setEmotion('joy', 80);
    engine.decay();

    // 80 - Max(8, 1) = 72
    expect(engine.emotions.joy).toBe(72);

    engine.setEmotion('joy', 0.4);
    engine.decay();
    // 0.4 - Max(0.04, 1) = -0.6. Clamps to 0 since -0.6 < zeroClamp (0.5)
    expect(engine.emotions.joy).toBe(0);
  });

  it('should apply baseline pull on baselineEmotion during decay', () => {
    const engine = new EmotionalStateEngine({
      emotionalModel: 'decay',
      baselineEmotion: 'anticipation',
      baselinePull: 0.05,
      decayRate: 0.1,
      linearDecay: 1.0,
      zeroClamp: 0.1,
    });

    engine.setEmotion('anticipation', 50);
    engine.decay();
    // Decay: 50 - Max(5, 1) = 45
    // Pull: 45 + 0.05 * (100 - 45) = 45 + 2.75 = 47.75
    expect(engine.emotions.anticipation).toBe(47.75);
  });

  it('should not decay emotions in reactive mode', () => {
    const engine = new EmotionalStateEngine({
      emotionalModel: 'reactive',
    });

    engine.setEmotion('joy', 80);
    engine.decay();
    engine.decay();
    engine.decay();

    // Reactive mode: decay() is a no-op, value stays unchanged
    expect(engine.emotions.joy).toBe(80);
  });

  it('should shift emotions only through addEmotion in reactive mode', () => {
    const engine = new EmotionalStateEngine({
      emotionalModel: 'reactive',
    });

    engine.setEmotion('joy', 80);
    const valueBefore = engine.emotions.joy;

    // Only addEmotion shifts the spectrum
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

    // Joy and Trust are opposites? No, Joy + Trust = Love dyad
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
});
