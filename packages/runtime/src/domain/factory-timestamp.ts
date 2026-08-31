import { factoryTimestampSchema } from "@agentlab/contracts";

/** Pure UTC timestamp arithmetic for trusted, caller-supplied factory timestamps. */
export function factoryTimestampMilliseconds(input: string): number {
  const timestamp = factoryTimestampSchema.parse(input);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u.exec(timestamp);
  if (match === null) throw new Error("Expected a canonical UTC millisecond timestamp.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const daysSinceEpoch = era * 146_097 + dayOfEra - 719_468;
  return (((daysSinceEpoch * 24 + hour) * 60 + minute) * 60 + second) * 1_000 + millisecond;
}

export function factoryTimestampDifferenceSeconds(earlier: string, later: string): number {
  return (factoryTimestampMilliseconds(later) - factoryTimestampMilliseconds(earlier)) / 1_000;
}

export function factoryTimestampAddSeconds(timestamp: string, seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error("Factory timestamp offset must be a non-negative safe integer.");
  }
  const milliseconds = factoryTimestampMilliseconds(timestamp) + seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("Factory timestamp offset exceeds the safe timestamp range.");
  }
  const millisecondsPerDay = 86_400_000;
  const daysSinceEpoch = Math.floor(milliseconds / millisecondsPerDay);
  const timeOfDay = milliseconds - daysSinceEpoch * millisecondsPerDay;
  const civil = civilDateFromEpochDays(daysSinceEpoch);
  const hour = Math.floor(timeOfDay / 3_600_000);
  const minute = Math.floor((timeOfDay % 3_600_000) / 60_000);
  const second = Math.floor((timeOfDay % 60_000) / 1_000);
  const millisecond = timeOfDay % 1_000;
  return factoryTimestampSchema.parse(
    `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millisecond, 3)}Z`
  );
}

function civilDateFromEpochDays(daysSinceEpoch: number): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const shifted = daysSinceEpoch + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  if (month <= 2) year += 1;
  return { year, month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
