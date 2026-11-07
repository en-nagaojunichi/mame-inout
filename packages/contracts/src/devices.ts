import { z } from "zod";

export const deviceApplyInputSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const deviceNameInputSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const deviceApprovalInputSchema = z.object({ expiresInDays: z.number().int().min(1).max(90).default(30) }).strict();
export const devicePageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.uuid().optional(),
}).strict();
export const deviceStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "REVOKED", "EXPIRED"]);

// 管理者一覧にも資格のハッシュやCookie値を含めず、照合と失効に必要な項目だけを返す。
export const deviceSummarySchema = z.object({
  id: z.uuid(), name: z.string(), status: deviceStatusSchema,
  confirmationCode: z.string().regex(/^[0-9A-F]{8}$/).nullable(),
  applicationExpiresAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(), approvedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(),
}).strict();
export const deviceApplicationResponseSchema = z.object({
  device: deviceSummarySchema, claimed: z.boolean(),
}).strict();
export const devicesResponseSchema = z.object({
  items: z.array(deviceSummarySchema), nextCursor: z.uuid().nullable(),
}).strict();
export const deviceClaimResponseSchema = z.object({ ok: z.literal(true), expiresAt: z.iso.datetime() }).strict();

export type DeviceSummary = z.infer<typeof deviceSummarySchema>;
export type DeviceApplicationResponse = z.infer<typeof deviceApplicationResponseSchema>;
export type DevicesResponse = z.infer<typeof devicesResponseSchema>;
