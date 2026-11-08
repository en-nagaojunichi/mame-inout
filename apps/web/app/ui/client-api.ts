import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";
import type { z } from "zod";

export const authClient = createAuthClient({ plugins: [passkeyClient()] });

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown, method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: method ?? (body === undefined ? "GET" : "POST"), cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("通信できませんでした。接続を確認して、もう一度お試しください。");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = data as { message?: unknown; code?: unknown } | null;
    throw new ApiFailure(typeof failure?.message === "string" ? failure.message : "操作を完了できませんでした。もう一度お試しください。", response.status, typeof failure?.code === "string" ? failure.code : undefined);
  }
  const result = schema.safeParse(data);
  if (!result.success) throw new Error("結果を確認できませんでした。状態を再確認してください。");
  return result.data;
}

export function requirePasskey() {
  if (!window.isSecureContext || !window.PublicKeyCredential) {
    throw new Error("パスキーを利用できません。SafariまたはChromeアプリで正しいURLを開いてください。");
  }
}

export function dateLabel(value: string | null) {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "まだありません";
}
