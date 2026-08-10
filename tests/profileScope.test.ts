/**
 * ProfileScope — unit tests for the profile identity dimension helpers.
 *
 * Profiles partition user-scoped data as a third scope field next to
 * project/username. Legacy documents predate the field, so the default
 * profile must match both "default" and missing/null.
 */
import { describe, it, expect } from "vitest";
import type { Request } from "express";
import {
  DEFAULT_PROFILE_ID,
  normalizeProfileId,
  profileFilter,
  resolveScope,
  scopeFilter,
} from "#src/utils/ProfileScope";

describe("normalizeProfileId", () => {
  it("passes a valid slug through", () => {
    expect(normalizeProfileId("work")).toBe("work");
    expect(normalizeProfileId("side-project-2")).toBe("side-project-2");
  });

  it("lowercases and trims", () => {
    expect(normalizeProfileId("  Work ")).toBe("work");
  });

  it("falls back to default for absent or invalid values", () => {
    expect(normalizeProfileId(undefined)).toBe(DEFAULT_PROFILE_ID);
    expect(normalizeProfileId(null)).toBe(DEFAULT_PROFILE_ID);
    expect(normalizeProfileId("")).toBe(DEFAULT_PROFILE_ID);
    expect(normalizeProfileId("has spaces")).toBe(DEFAULT_PROFILE_ID);
    expect(normalizeProfileId("../../etc/passwd")).toBe(DEFAULT_PROFILE_ID);
    expect(normalizeProfileId("-leading-dash")).toBe(DEFAULT_PROFILE_ID);
    expect(normalizeProfileId("x".repeat(65))).toBe(DEFAULT_PROFILE_ID);
    expect(normalizeProfileId(42)).toBe(DEFAULT_PROFILE_ID);
  });
});

describe("profileFilter", () => {
  it("matches legacy (missing/null) documents for the default profile", () => {
    expect(profileFilter(DEFAULT_PROFILE_ID)).toEqual({
      $in: [DEFAULT_PROFILE_ID, null],
    });
  });

  it("matches exactly for non-default profiles", () => {
    expect(profileFilter("work")).toBe("work");
  });
});

describe("resolveScope / scopeFilter", () => {
  const request = {
    project: "p1",
    username: "u1",
    profileId: "work",
  } as unknown as Request;

  it("resolves literal stamp values", () => {
    expect(resolveScope(request)).toEqual({
      project: "p1",
      username: "u1",
      profileId: "work",
    });
  });

  it("defaults absent identity fields", () => {
    expect(resolveScope({} as Request)).toEqual({
      project: "any",
      username: "any",
      profileId: DEFAULT_PROFILE_ID,
    });
  });

  it("builds a legacy-tolerant filter for the default profile", () => {
    expect(scopeFilter({ project: "p1", username: "u1" } as Request)).toEqual({
      project: "p1",
      username: "u1",
      profileId: { $in: [DEFAULT_PROFILE_ID, null] },
    });
  });

  it("builds an exact filter for a named profile", () => {
    expect(scopeFilter(request)).toEqual({
      project: "p1",
      username: "u1",
      profileId: "work",
    });
  });
});
