import { describe, expect, it } from "vitest";

import {
  factoryTimestampAddSeconds,
  factoryTimestampDifferenceSeconds,
  factoryTimestampMilliseconds,
  factoryTimestampSubtractSeconds
} from "../../packages/runtime/src/domain/factory-timestamp.js";

describe("factory timestamp arithmetic", () => {
  it("adds across day, leap-day, and year boundaries without ambient time", () => {
    expect(factoryTimestampAddSeconds("2026-08-30T23:59:59.999Z", 1)).toBe(
      "2026-08-31T00:00:00.999Z"
    );
    expect(factoryTimestampAddSeconds("2028-02-28T23:59:59.000Z", 1)).toBe(
      "2028-02-29T00:00:00.000Z"
    );
    expect(factoryTimestampAddSeconds("2100-02-28T23:59:59.000Z", 1)).toBe(
      "2100-03-01T00:00:00.000Z"
    );
    expect(factoryTimestampAddSeconds("2026-12-31T23:59:59.000Z", 1)).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });

  it("subtracts across ordinary and leap-day boundaries without ambient time", () => {
    expect(factoryTimestampSubtractSeconds("2026-03-01T00:00:00.000Z", 86_400)).toBe(
      "2026-02-28T00:00:00.000Z"
    );
    expect(factoryTimestampSubtractSeconds("2028-03-01T00:00:00.000Z", 86_400)).toBe(
      "2028-02-29T00:00:00.000Z"
    );
  });

  it("round-trips its exact second offset", () => {
    const start = "2026-08-30T12:08:00.000Z";
    const end = factoryTimestampAddSeconds(start, 604_800);
    expect(factoryTimestampDifferenceSeconds(start, end)).toBe(604_800);
    expect(factoryTimestampMilliseconds(end) - factoryTimestampMilliseconds(start)).toBe(
      604_800_000
    );
  });

  it("rejects invalid offsets", () => {
    expect(() => factoryTimestampAddSeconds("2026-08-30T12:08:00.000Z", -1)).toThrow(
      "non-negative safe integer"
    );
    expect(() => factoryTimestampAddSeconds("2026-08-30T12:08:00.000Z", 0.5)).toThrow(
      "non-negative safe integer"
    );
    expect(() => factoryTimestampSubtractSeconds("2026-08-30T12:08:00.000Z", -1)).toThrow(
      "non-negative safe integer"
    );
  });
});
