import { describe, expect, it } from "vitest";

import { resolveFactoryDailyScheduleSlot } from "../../packages/runtime/src/domain/factory-schedule-time.js";
import {
  TEST_FACTORY_SCHEDULE_DEADLINE,
  TEST_FACTORY_SCHEDULED_FOR,
  testFactorySchedulePolicy
} from "../helpers/factory-schedule.js";

describe("resolveFactoryDailyScheduleSlot", () => {
  it("returns the exact current UTC slot inside its start deadline", () => {
    expect(
      resolveFactoryDailyScheduleSlot(testFactorySchedulePolicy(), "2026-08-31T12:30:00.000Z")
    ).toEqual({
      scheduledFor: TEST_FACTORY_SCHEDULED_FOR,
      deadlineAt: TEST_FACTORY_SCHEDULE_DEADLINE,
      status: "due"
    });
  });

  it("does not run a missed slot or borrow authority from a future slot", () => {
    expect(
      resolveFactoryDailyScheduleSlot(testFactorySchedulePolicy(), "2026-08-31T12:30:00.001Z")
    ).toMatchObject({ status: "missed-deadline" });
    expect(
      resolveFactoryDailyScheduleSlot(testFactorySchedulePolicy(), "2026-08-31T11:59:59.999Z")
    ).toEqual({
      scheduledFor: "2026-08-30T12:00:00.000Z",
      deadlineAt: "2026-08-30T12:30:00.000Z",
      status: "missed-deadline"
    });
  });
});
