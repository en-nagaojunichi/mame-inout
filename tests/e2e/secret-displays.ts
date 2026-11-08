import type { Page } from "@playwright/test";
import { invitationResponseSchema, recoveryCodesResponseSchema } from "@mame/contracts";

// 実APIが発行したコードはテストのメモリだけに保持し、画面記録へは同形のダミーだけを渡す。
export async function maskSecretDisplays(page: Page) {
  const issued = { recoveries: [] as string[][], invitations: [] as { code: string; expiresAt: string }[] };
  await page.route("**/api/admin/recovery-codes", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) { await route.fulfill({ response }); return; }
    const parsed = recoveryCodesResponseSchema.safeParse(await response.json());
    if (!parsed.success) { await route.abort(); throw new Error("復旧コードの応答形式を確認できませんでした。"); }
    issued.recoveries.push(parsed.data.codes);
    await route.fulfill({ response, json: { codes: parsed.data.codes.map((_, index) => `E2E_DISPLAY_ONLY_${index}`.padEnd(43, "_")) } });
  });
  await page.route("**/api/admin/invitations", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) { await route.fulfill({ response }); return; }
    const parsed = invitationResponseSchema.safeParse(await response.json());
    if (!parsed.success) { await route.abort(); throw new Error("招待コードの応答形式を確認できませんでした。"); }
    issued.invitations.push(parsed.data);
    await route.fulfill({ response, json: { code: "E2E_INVITATION_DISPLAY_ONLY".padEnd(43, "_"), expiresAt: parsed.data.expiresAt } });
  });
  return issued;
}

export function cookieName(line: string) {
  const name = line.split("=", 1)[0] ?? "";
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : "UNKNOWN";
}

export function cookieMetadata(line: string) {
  const attributes = new Map(line.split(";").slice(1).map((part) => {
    const [name, ...value] = part.trim().split("=");
    return [name?.toLowerCase() ?? "", value.join("=")];
  }));
  const path = attributes.get("path");
  const sameSite = attributes.get("samesite")?.toLowerCase();
  const maxAge = attributes.get("max-age");
  const expires = attributes.get("expires");
  return {
    name: cookieName(line), path: path === "/" || path === "/api" ? path : path ? "OTHER" : null,
    secure: attributes.has("secure"), httpOnly: attributes.has("httponly"),
    sameSite: sameSite && ["lax", "strict", "none"].includes(sameSite) ? sameSite : null,
    maxAge: maxAge && /^-?\d+$/.test(maxAge) ? Number(maxAge) : null,
    expires: expires && Number.isFinite(Date.parse(expires)) ? new Date(expires).toISOString() : null,
  };
}
