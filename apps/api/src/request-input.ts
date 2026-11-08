import type { Context } from "hono";
import { AttendanceError } from "./attendance-rules.js";

export function assertJsonContentType(c: Context) {
  if (c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new AttendanceError("UNSUPPORTED_MEDIA_TYPE", 415, "この操作の送信形式を確認してください。画面を開き直して再度お試しください。");
  }
}

export async function readJson(c: Context): Promise<unknown> {
  // 各経路が入力を読む地点で形式を検証し、既存の認可順序を変えない。
  // Origin検証とは別に、JSONを別の形式の本文として解釈することを防ぐ。
  // 構文エラーは既存の入力スキーマへ渡し、例外に本文や資格を付けて返さない。
  assertJsonContentType(c);
  return c.req.json().catch(() => null);
}
