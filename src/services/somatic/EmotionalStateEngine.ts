import {
  PLUTCHIK_OPPOSITES,
  PLUTCHIK_DYADS,
  type EmotionPersonality,
  type PrimaryEmotion,
  type DominantEmotionResult,
  PRIMARY_EMOTIONS,
  DEFAULT_EMOTION_PERSONALITY,
} from "./SomaticConstants.ts";

export interface SerializedEmotionalState {
  emotions: Record<PrimaryEmotion, number>;
  personality?: Partial<EmotionPersonality>;
}

function getDyadKey(firstEmotion: string, secondEmotion: string): string {
  return [firstEmotion, secondEmotion].sort().join("+");
}

export class EmotionalStateEngine {
  emotions: Record<PrimaryEmotion, number>;
  personality: EmotionPersonality;

  constructor(personalityOverrides: Partial<EmotionPersonality> = {}) {
    this.personality = {
      ...DEFAULT_EMOTION_PERSONALITY,
      ...personalityOverrides,
      baselineLevels: {
        ...DEFAULT_EMOTION_PERSONALITY.baselineLevels,
        ...(personalityOverrides.baselineLevels || {}),
      },
    };

    // A fresh agent wakes up at its resting personality, not emotionally blank.
    this.emotions = {
      joy: 0,
      trust: 0,
      fear: 0,
      surprise: 0,
      sadness: 0,
      disgust: 0,
      anger: 0,
      anticipation: 0,
    };
    for (const emotion of PRIMARY_EMOTIONS) {
      this.emotions[emotion] = this.getBaseline(emotion);
    }
  }

  private getBaseline(emotion: PrimaryEmotion): number {
    return this.personality.baselineLevels[emotion] ?? 0;
  }

  /**
   * Time-based decay toward the personality's baseline levels.
   *
   * Deviations from baseline halve every `decayHalfLifeMinutes`, so spikes
   * (in either direction) are temporary states, not permanent ratchets.
   * Without this, a busy channel pumps a handful of emotions to 100 where
   * they sit forever and the dominant mood never changes.
   */
  decay(elapsedMinutes: number): void {
    const { decayHalfLifeMinutes } = this.personality;
    if (!decayHalfLifeMinutes || decayHalfLifeMinutes <= 0) return;
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) return;

    const retention = Math.pow(0.5, elapsedMinutes / decayHalfLifeMinutes);

    for (const emotion of PRIMARY_EMOTIONS) {
      const baseline = this.getBaseline(emotion);
      const deviation = this.emotions[emotion] - baseline;
      const next = baseline + deviation * retention;
      // Snap near-baseline residue so values settle exactly at rest.
      this.emotions[emotion] =
        Math.abs(next - baseline) < 0.05 ? baseline : next;
    }
  }

  addEmotion(emotion: PrimaryEmotion, intensity: number = 20): void {
    if (!PRIMARY_EMOTIONS.includes(emotion)) {
      return;
    }

    const { sensitivity, volatility, emotionalInertia } = this.personality;
    const currentDominant = this.getDominantEmotion().emotion;

    let inertiaFactor = 1;
    if (currentDominant !== emotion && currentDominant !== "neutral") {
      const inertiaValue =
        this.emotions[currentDominant as PrimaryEmotion] || 0;
      inertiaFactor = 1 - emotionalInertia * (inertiaValue / 100);
    }

    const adjustedIntensity =
      intensity * sensitivity * volatility * inertiaFactor;

    const currentValue = this.emotions[emotion];
    const headroom = 100 - currentValue;
    const actualGain = adjustedIntensity * (headroom / 100);
    this.emotions[emotion] = Math.min(100, currentValue + actualGain);

    const opposite = PLUTCHIK_OPPOSITES[emotion];
    if (opposite) {
      this.emotions[opposite] = Math.max(
        0,
        this.emotions[opposite] - adjustedIntensity * 0.5,
      );
    }
  }

  getDominantEmotion(): DominantEmotionResult {
    const { threshold, dyadThreshold } = this.personality;

    const sorted = (
      Object.entries(this.emotions) as [PrimaryEmotion, number][]
    ).sort(([, firstValue], [, secondValue]) => secondValue - firstValue);

    const [topName, topValue] = sorted[0];
    const [secondName, secondValue] = sorted[1];

    if (topValue < threshold) {
      return {
        emotion: "neutral",
        intensity: 0,
        all: { ...this.emotions },
      };
    }

    if (secondValue >= threshold && topValue > 0) {
      const ratio = secondValue / topValue;
      if (ratio >= dyadThreshold) {
        const key = getDyadKey(topName, secondName);
        const dyadName = PLUTCHIK_DYADS[key];
        if (dyadName) {
          return {
            emotion: dyadName,
            intensity: (topValue + secondValue) / 2,
            all: { ...this.emotions },
            isDyad: true,
            components: [topName, secondName],
          };
        }
      }
    }

    return {
      emotion: topName,
      intensity: topValue,
      all: { ...this.emotions },
    };
  }

  reset(): void {
    for (const emotion of PRIMARY_EMOTIONS) {
      this.emotions[emotion] = this.getBaseline(emotion);
    }
  }

  setEmotion(emotion: PrimaryEmotion, value: number): void {
    if (PRIMARY_EMOTIONS.includes(emotion)) {
      this.emotions[emotion] = Math.max(0, Math.min(100, value));
    }
  }

  getEmotionValues(): Record<PrimaryEmotion, number> {
    return { ...this.emotions };
  }

  serialize(): SerializedEmotionalState {
    return {
      emotions: { ...this.emotions },
    };
  }

  static deserialize(
    data: SerializedEmotionalState,
    personalityOverrides: Partial<EmotionPersonality> = {},
  ): EmotionalStateEngine {
    const engine = new EmotionalStateEngine({
      ...(data.personality || {}),
      ...personalityOverrides,
    });
    for (const emotion of PRIMARY_EMOTIONS) {
      if (typeof data.emotions[emotion] === "number") {
        engine.emotions[emotion] = Math.max(
          0,
          Math.min(100, data.emotions[emotion]),
        );
      }
    }
    return engine;
  }
}
