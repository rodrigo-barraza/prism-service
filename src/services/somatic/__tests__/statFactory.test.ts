import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

import StatFactory from "#src/services/somatic/StatFactory";
import type { StatInstance } from "#src/services/somatic/StatFactory";

// ═══════════════════════════════════════════════════════════════
// StatFactory — Basic Creation
// ═══════════════════════════════════════════════════════════════

describe("StatFactory.create", () => {
  it("creates a stat with default options", () => {
    const stat = StatFactory.create("testStat");
    expect(stat.getName()).toBe("testStat");
    expect(stat.getLevel()).toBe(0);
  });

  it("creates a stat with custom initial value", () => {
    const stat = StatFactory.create("energy", { initial: 100 });
    expect(stat.getLevel()).toBe(100);
  });

  it("creates a stat with custom min/max bounds", () => {
    const stat = StatFactory.create("mood", { min: -10, max: 10, initial: 0 });
    expect(stat.getLevel()).toBe(0);
    stat.setLevel(15);
    expect(stat.getLevel()).toBe(10);
    stat.setLevel(-20);
    expect(stat.getLevel()).toBe(-10);
  });

  it("creates a stat with a custom step size", () => {
    const stat = StatFactory.create("sickness", { min: 0, max: 100, initial: 0, step: 10 });
    stat.increase();
    expect(stat.getLevel()).toBe(10);
    stat.increase();
    expect(stat.getLevel()).toBe(20);
    stat.decrease();
    expect(stat.getLevel()).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════
// StatFactory — Clamping Behavior
// ═══════════════════════════════════════════════════════════════

describe("StatFactory — clamping", () => {
  let stat: StatInstance;

  beforeEach(() => {
    stat = StatFactory.create("test", { min: 0, max: 100, initial: 50 });
  });

  it("clamps increase to max", () => {
    stat.setLevel(99);
    stat.increase();
    expect(stat.getLevel()).toBe(100);
    stat.increase();
    expect(stat.getLevel()).toBe(100);
  });

  it("clamps decrease to min", () => {
    stat.setLevel(1);
    stat.decrease();
    expect(stat.getLevel()).toBe(0);
    stat.decrease();
    expect(stat.getLevel()).toBe(0);
  });

  it("clamps setLevel above max", () => {
    const level = stat.setLevel(999);
    expect(level).toBe(100);
    expect(stat.getLevel()).toBe(100);
  });

  it("clamps setLevel below min", () => {
    const level = stat.setLevel(-999);
    expect(level).toBe(0);
    expect(stat.getLevel()).toBe(0);
  });

  it("handles multiplier on increase", () => {
    stat.setLevel(90);
    stat.increase(5);
    expect(stat.getLevel()).toBe(95);
  });

  it("handles multiplier on decrease", () => {
    stat.setLevel(10);
    stat.decrease(3);
    expect(stat.getLevel()).toBe(7);
  });

  it("increase with large multiplier clamps to max", () => {
    stat.setLevel(50);
    stat.increase(200);
    expect(stat.getLevel()).toBe(100);
  });

  it("decrease with large multiplier clamps to min", () => {
    stat.setLevel(50);
    stat.decrease(200);
    expect(stat.getLevel()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// StatFactory — Reset
// ═══════════════════════════════════════════════════════════════

describe("StatFactory — reset", () => {
  it("resets to initial value", () => {
    const stat = StatFactory.create("test", { initial: 42 });
    stat.setLevel(99);
    expect(stat.getLevel()).toBe(99);
    stat.reset();
    expect(stat.getLevel()).toBe(42);
  });
});

// ═══════════════════════════════════════════════════════════════
// StatFactory — onChange Callback
// ═══════════════════════════════════════════════════════════════

describe("StatFactory — onChange callback", () => {
  it("fires on setLevel", () => {
    const onChangeSpy = vi.fn();
    const stat = StatFactory.create("test", { onChange: onChangeSpy });
    stat.setLevel(50);
    expect(onChangeSpy).toHaveBeenCalledWith(50, "test");
  });

  it("fires on increase", () => {
    const onChangeSpy = vi.fn();
    const stat = StatFactory.create("test", { onChange: onChangeSpy });
    stat.increase();
    expect(onChangeSpy).toHaveBeenCalledWith(1, "test");
  });

  it("fires on decrease", () => {
    const onChangeSpy = vi.fn();
    const stat = StatFactory.create("test", { initial: 50, onChange: onChangeSpy });
    stat.decrease();
    expect(onChangeSpy).toHaveBeenCalledWith(49, "test");
  });

  it("fires on reset", () => {
    const onChangeSpy = vi.fn();
    const stat = StatFactory.create("test", { initial: 42, onChange: onChangeSpy });
    stat.setLevel(99);
    onChangeSpy.mockClear();
    stat.reset();
    expect(onChangeSpy).toHaveBeenCalledWith(42, "test");
  });

  it("does not fire when onChange is null", () => {
    const stat = StatFactory.create("test", { onChange: null });
    expect(() => {
      stat.setLevel(50);
      stat.increase();
      stat.decrease();
      stat.reset();
    }).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// StatFactory — Negative range (mood-style)
// ═══════════════════════════════════════════════════════════════

describe("StatFactory — negative range (mood-style)", () => {
  let mood: StatInstance;

  beforeEach(() => {
    mood = StatFactory.create("mood", { min: -10, max: 10, initial: 0 });
  });

  it("can decrease into negative range", () => {
    mood.decrease(5);
    expect(mood.getLevel()).toBe(-5);
  });

  it("clamps at negative min", () => {
    mood.decrease(15);
    expect(mood.getLevel()).toBe(-10);
  });

  it("increase from negative towards positive", () => {
    mood.setLevel(-5);
    mood.increase(8);
    expect(mood.getLevel()).toBe(3);
  });

  it("can cross zero boundary in both directions", () => {
    mood.decrease(3);
    expect(mood.getLevel()).toBe(-3);
    mood.increase(6);
    expect(mood.getLevel()).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// StatFactory — Edge Cases / Adversarial
// ═══════════════════════════════════════════════════════════════

describe("StatFactory — adversarial edge cases", () => {
  it("handles zero multiplier (no change)", () => {
    const stat = StatFactory.create("test", { initial: 50 });
    stat.increase(0);
    expect(stat.getLevel()).toBe(50);
    stat.decrease(0);
    expect(stat.getLevel()).toBe(50);
  });

  it("handles negative multiplier (reversal)", () => {
    const stat = StatFactory.create("test", { initial: 50 });
    stat.increase(-1);
    expect(stat.getLevel()).toBe(49);
    stat.decrease(-1);
    expect(stat.getLevel()).toBe(50);
  });

  it("handles NaN setLevel by clamping", () => {
    const stat = StatFactory.create("test", { initial: 50 });
    stat.setLevel(NaN);
    expect(stat.getLevel()).toBe(0);
  });

  it("handles Infinity setLevel by clamping to max", () => {
    const stat = StatFactory.create("test", { max: 100 });
    stat.setLevel(Infinity);
    expect(stat.getLevel()).toBe(100);
  });

  it("handles -Infinity setLevel by clamping to min", () => {
    const stat = StatFactory.create("test", { min: 0 });
    stat.setLevel(-Infinity);
    expect(stat.getLevel()).toBe(0);
  });

  it("multiple stats are independent instances", () => {
    const statAlpha = StatFactory.create("alpha", { initial: 10 });
    const statBeta = StatFactory.create("beta", { initial: 20 });
    statAlpha.increase(5);
    expect(statAlpha.getLevel()).toBe(15);
    expect(statBeta.getLevel()).toBe(20);
  });
});
