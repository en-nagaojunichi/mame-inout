// 施設の時計で表示・入力し、操作した端末のタイムゾーンへ依存させない。
export function facilityTime(value: string | null, timeZone: string) {
  return value ? new Intl.DateTimeFormat("ja-JP", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "退室の記録なし";
}

function localParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

export function localTimeInput(value: string, timeZone: string) {
  const date = new Date(value);
  return `${localParts(date, timeZone)}.${String(date.getUTCMilliseconds()).padStart(3, "0")}`;
}

export function inputTimeToUtc(value: string, timeZone: string, original?: string) {
  if (original && localTimeInput(original, timeZone) === value) return original;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) throw new Error("入退室の日時を入力してください。");
  const [, year, month, day, hour, minute, second = "00", fraction = "0"] = match;
  const wall = Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second, +fraction.padEnd(3, "0"));
  const canonical = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0")}`;
  const offsets = new Set<number>();
  // 夏時間の前後の候補を照合し、存在しない時刻・二通りに解釈できる時刻を推測で確定しない。
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = new Date(wall + hours * 3_600_000);
    offsets.add(Date.parse(`${localParts(sample, timeZone)}Z`) - Math.floor(sample.getTime() / 1000) * 1000);
  }
  const candidates = [...offsets].map((offset) => new Date(wall - offset)).filter((date) => localTimeInput(date.toISOString(), timeZone) === canonical);
  if (candidates.length !== 1) throw new Error("施設のタイムゾーンでこの日時を一つに確定できません。夏時間の切り替え日時と入力内容を確認してください。");
  return candidates[0]!.toISOString();
}

export function elapsedLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours}時間${minutes % 60}分` : `${minutes}分`;
}

export function visitStatus(visit: { canceledAt: string | null; exitedAt: string | null }) {
  return visit.canceledAt ? "取消済み" : visit.exitedAt ? "退室済み" : "記録上の在室";
}
