import { z } from "zod";

export const defaultDisplayName = "入退出管理システム";
export const appearanceImageMaxBytes = 64 * 1024;
export const appearanceImageMaxSide = 256;
const image = z.string().min(1).max(Math.ceil(appearanceImageMaxBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).nullable().optional();

export const appearanceInputSchema = z.object({
  expectedVersion: z.number().int().positive().max(2_147_483_646),
  displayName: z.string().trim().min(1).max(64).refine((name) => !/[\u0000-\u001f\u007f]/.test(name)),
  // 未指定は現在の画像を保持し、nullの明示だけを既定の画像へ戻す。
  iconPng: image,
  faviconPng: image,
}).strict();

export const appearanceResponseSchema = z.object({
  displayName: z.string().min(1).max(64),
  version: z.number().int().positive(),
  iconUrl: z.string().regex(/^\/api\/appearance\/icon\?v=\d+$/),
  faviconUrl: z.string().regex(/^\/api\/appearance\/favicon\?v=\d+$/),
  customIcon: z.boolean(),
  customFavicon: z.boolean(),
}).strict();

export type Appearance = z.infer<typeof appearanceResponseSchema>;
export type AppearanceInput = z.infer<typeof appearanceInputSchema>;
