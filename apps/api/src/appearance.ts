import { appearanceInputSchema, appearanceResponseSchema, type AppearanceInput } from "@mame/contracts";
import type { Database } from "./db.js";
import { AttendanceError } from "./attendance-rules.js";
import { assertAdministrator, identityClock, type AdminActor } from "./identity.js";
import { validateAppearancePng } from "./appearance-png.js";

const options = { isolationLevel: "ReadCommitted" as const, maxWait: 15_000, timeout: 15_000 };
type AppearanceRow = { displayName: string; version: number; icon: Uint8Array | null; favicon: Uint8Array | null };
function dto(row: AppearanceRow) {
  return appearanceResponseSchema.parse({ displayName: row.displayName, version: row.version,
    iconUrl: `/api/appearance/icon?v=${row.version}`, faviconUrl: `/api/appearance/favicon?v=${row.version}`,
    customIcon: row.icon !== null, customFavicon: row.favicon !== null });
}
export async function getAppearance(db: Database) {
  return dto(await db.appearance.findUniqueOrThrow({ where: { id: 1 } }));
}
export async function updateAppearance(db: Database, actor: AdminActor, input: AppearanceInput) {
  const parsed = appearanceInputSchema.safeParse(input);
  if (!parsed.success) throw new AttendanceError("INVALID_INPUT", 422, "表示名と更新状態を確認してください。");
  const { expectedVersion, displayName, iconPng, faviconPng } = parsed.data;
  const icon = typeof iconPng === "string" ? new Uint8Array(validateAppearancePng(iconPng)) : iconPng;
  const favicon = typeof faviconPng === "string" ? new Uint8Array(validateAppearancePng(faviconPng)) : faviconPng;
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor, false);
    // 管理者の失効と表示の同時編集を直列化し、待機後にも認可を取り直す。
    await tx.$queryRaw`SELECT id FROM "Appearance" WHERE id = 1 FOR UPDATE`;
    await assertAdministrator(tx, actor, false);
    const current = await tx.appearance.findUniqueOrThrow({ where: { id: 1 } });
    if (current.version !== expectedVersion) throw new AttendanceError("VERSION_CONFLICT", 409, "ほかの管理者が表示設定を変更しました。現在の設定を読み直してから保存してください。");
    const row = await tx.appearance.update({ where: { id: 1 }, data: { displayName,
      ...(icon !== undefined ? { icon } : {}), ...(favicon !== undefined ? { favicon } : {}),
      version: { increment: 1 }, updatedAt: await identityClock(tx) } });
    // 画像原文・表示名を監査へ複製せず、更新版と変更対象だけを保存する。
    await tx.auditEvent.create({ data: { action: "APPEARANCE_UPDATED", actorType: "ADMIN", actorUserId: actor.userId,
      details: { version: row.version, fields: ["displayName", ...(icon !== undefined ? ["icon"] : []), ...(favicon !== undefined ? ["favicon"] : [])] } } });
    return dto(row);
  }, options);
}

// 既定アイコンは本プロジェクト独自の入退室を表す図形で、外部配信を必要としない。
export const defaultAppearanceSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#315a53"/><path d="M26 14h20v36H26M10 32h25m-8-8 8 8-8 8" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
