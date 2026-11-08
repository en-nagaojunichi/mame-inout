import type { AttendanceMode } from "@mame/contracts";

export type AttendanceErrorStatus = 401 | 403 | 404 | 409 | 410 | 415 | 422 | 429 | 503;

export class AttendanceError extends Error {
  override readonly name = "AttendanceError";
  constructor(readonly code: string, readonly status: AttendanceErrorStatus, message: string) {
    super(message);
  }
}

export type VisitInterval = { enteredAt: Date; exitedAt: Date | null };

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function assertVisitTimes(enteredAt: Date, exitedAt: Date | null, now: Date): void {
  if (!validDate(enteredAt) || !validDate(now) || (exitedAt !== null && !validDate(exitedAt)) ||
      enteredAt > now || (exitedAt !== null && (exitedAt < enteredAt || exitedAt > now))) {
    throw new AttendanceError("INVALID_TIME", 422, "入退室の時刻を確認してください。未来や入退室の逆転は登録できません。");
  }
}

export function intervalsOverlap(a: VisitInterval, b: VisitInterval): boolean {
  for (const interval of [a, b]) {
    if (!validDate(interval.enteredAt) || (interval.exitedAt !== null &&
        (!validDate(interval.exitedAt) || interval.exitedAt < interval.enteredAt))) {
      throw new AttendanceError("INVALID_TIME", 422, "入退室の時刻を確認してください。");
    }
  }
  // 区間は[入室,退室)。連続する区間と長さゼロの終了済み区間は重複しない。
  if (a.exitedAt?.getTime() === a.enteredAt.getTime() || b.exitedAt?.getTime() === b.enteredAt.getTime()) return false;
  return a.enteredAt.getTime() < (b.exitedAt?.getTime() ?? Infinity) &&
    b.enteredAt.getTime() < (a.exitedAt?.getTime() ?? Infinity);
}

export function attendanceOutcome(mode: AttendanceMode, isInside: boolean): "RECORDED" | "ALREADY_INSIDE" | "NOT_INSIDE" {
  if (mode === "IN" && isInside) return "ALREADY_INSIDE";
  if (mode === "OUT" && !isInside) return "NOT_INSIDE";
  return "RECORDED";
}

export function createFacilityDateTimeFormatter(timeZone: string): (date: Date) => string {
  let formatter: Intl.DateTimeFormat;
  try {
    // 一括出力では施設ごとに一度だけ作り、行数に比例したIntlの初期化を避ける。
    // グローバルには保持せず、別施設・別設定の表示へ使い回さない。
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
  } catch {
    throw new AttendanceError("INVALID_TIMEZONE", 422, "施設のタイムゾーンを確認してください。");
  }
  return (date) => {
    if (!validDate(date)) throw new AttendanceError("INVALID_TIME", 422, "表示する時刻を確認してください。");
    try {
      const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    } catch {
      throw new AttendanceError("INVALID_TIMEZONE", 422, "施設のタイムゾーンを確認してください。");
    }
  };
}

export function facilityDateTime(date: Date, timeZone: string): string {
  // 日時とタイムゾーンの両方が不正でも、従来どおり日時のエラーを先に返す。
  if (!validDate(date)) throw new AttendanceError("INVALID_TIME", 422, "表示する時刻を確認してください。");
  return createFacilityDateTimeFormatter(timeZone)(date);
}
