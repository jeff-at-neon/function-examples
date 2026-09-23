import { describe, expect, it } from "vitest";
import {
  isWithinQuietHours,
  localMinutes,
  minutesUntilEnd,
  parseQuietHours,
  releaseAfterQuietHours,
} from "../src/quiet-hours.js";

describe("parseQuietHours", () => {
  it("parses HH:MM-HH:MM", () => {
    expect(parseQuietHours("22:00-08:00")).toEqual({ startMin: 22 * 60, endMin: 8 * 60 });
  });
  it("rejects malformed or empty input", () => {
    expect(parseQuietHours("")).toBeNull();
    expect(parseQuietHours(null)).toBeNull();
    expect(parseQuietHours("25:00-08:00")).toBeNull();
    expect(parseQuietHours("09:00-09:00")).toBeNull(); // zero-length
  });
});

describe("isWithinQuietHours (crosses midnight)", () => {
  const w = { startMin: 22 * 60, endMin: 8 * 60 }; // 22:00-08:00

  it("is inside late at night and early morning", () => {
    expect(isWithinQuietHours(23 * 60, w)).toBe(true);
    expect(isWithinQuietHours(2 * 60, w)).toBe(true);
  });
  it("is outside during the day", () => {
    expect(isWithinQuietHours(12 * 60, w)).toBe(false);
  });
  it("is exclusive at the end boundary", () => {
    expect(isWithinQuietHours(8 * 60, w)).toBe(false);
    expect(isWithinQuietHours(22 * 60, w)).toBe(true);
  });

  it("handles a same-day window", () => {
    const day = { startMin: 9 * 60, endMin: 17 * 60 };
    expect(isWithinQuietHours(12 * 60, day)).toBe(true);
    expect(isWithinQuietHours(20 * 60, day)).toBe(false);
  });
});

describe("minutesUntilEnd", () => {
  const w = { startMin: 22 * 60, endMin: 8 * 60 };
  it("counts across midnight from the evening", () => {
    // 23:00 -> 08:00 is 9 hours
    expect(minutesUntilEnd(23 * 60, w)).toBe(9 * 60);
  });
  it("counts within the morning part", () => {
    // 02:00 -> 08:00 is 6 hours
    expect(minutesUntilEnd(2 * 60, w)).toBe(6 * 60);
  });
});

describe("localMinutes", () => {
  it("reads the wall-clock minute in a timezone", () => {
    // 2026-01-01T12:00:00Z is 07:00 in America/New_York (UTC-5 in January)
    const d = new Date("2026-01-01T12:00:00Z");
    expect(localMinutes(d, "America/New_York")).toBe(7 * 60);
    expect(localMinutes(d, "UTC")).toBe(12 * 60);
  });
});

describe("releaseAfterQuietHours", () => {
  it("returns null when not in quiet hours", () => {
    const d = new Date("2026-01-01T12:00:00Z"); // noon UTC
    expect(releaseAfterQuietHours(d, "UTC", { startMin: 22 * 60, endMin: 8 * 60 })).toBeNull();
  });
  it("defers to the window end when inside", () => {
    const d = new Date("2026-01-01T23:00:00Z"); // 23:00 UTC, inside 22-08
    const release = releaseAfterQuietHours(d, "UTC", { startMin: 22 * 60, endMin: 8 * 60 });
    // 9 hours later -> 08:00 next day
    expect(release?.toISOString()).toBe("2026-01-02T08:00:00.000Z");
  });
});
