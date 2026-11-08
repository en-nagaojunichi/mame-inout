import { z } from "zod";

// 保存日数は24時間単位。施設の表示用タイムゾーンで日数を増減させない。
export const retentionDaysSchema = z.number().int().min(1).max(3650);
const count = z.number().int().nonnegative();
export const retentionPreviewInputSchema = z.object({ days: retentionDaysSchema }).strict();
export const retentionPreviewSchema = z.object({
  days: retentionDaysSchema, expectedVersion: z.number().int().positive(), cutoff: z.iso.datetime(),
  visits: count, revisions: count, auditEvents: count, openVisits: count,
  confirmationToken: z.string().min(1).max(2048),
}).strict();
export const retentionUpdateInputSchema = z.object({
  days: retentionDaysSchema, expectedVersion: z.number().int().positive(), confirmationToken: z.string().min(1).max(2048),
}).strict();
export const retentionPolicySchema = z.object({
  days: retentionDaysSchema, version: z.number().int().positive(), backupRetentionDays: count,
  lastRunAt: z.iso.datetime().nullable(), lastDeletedVisits: count, lastDeletedAuditEvents: count,
}).strict();
export const deletionInputSchema = z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive() }).strict();
export const deletionPreviewSchema = z.object({
  personId: z.uuid(), version: z.number().int().positive(), displayName: z.string().min(1).max(100),
  visits: count, revisions: count, openVisits: count, backupRetentionDays: count,
}).strict();
export const deletionStatusSchema = z.object({
  operationId: z.uuid(), personId: z.uuid(), requestedAt: z.iso.datetime(),
  state: z.enum(["PENDING", "COMPLETED"]), completedAt: z.iso.datetime().nullable(),
  errorCode: z.enum(["EXTERNAL_STORAGE_UNAVAILABLE", "ERASURE_FAILED"]).nullable(),
}).strict();
export const privacyResponseSchema = z.object({
  retention: retentionPolicySchema, deletions: z.array(deletionStatusSchema).max(100), pendingCount: count,
}).strict();
export const diagnosticsResponseSchema = z.object({
  checkedAt: z.iso.datetime(), origin: z.url(), https: z.boolean(), database: z.literal("connected"),
  passkey: z.object({ rpId: z.string(), userVerification: z.literal("required") }).strict(),
  disk: z.object({ availableBytes: count, totalBytes: count, scope: z.literal("container") }).strict().nullable(),
  backup: z.object({ lastCompletedAt: z.iso.datetime().nullable(), externalConfirmed: z.boolean(), retentionDays: count }).strict(),
  privacy: z.object({ pendingDeletions: count, lastRetentionRunAt: z.iso.datetime().nullable() }).strict(),
}).strict();

// 復元に必要な内部IDだけを持つ。氏名やQR、管理者名は台帳へ複製しない。
export const deletionLedgerSchema = z.object({
  format: z.literal(1), deploymentId: z.uuid(), generation: count,
  instructions: z.array(z.object({
    sequence: z.number().int().positive(), operationId: z.uuid(), personId: z.uuid(), requestedAt: z.iso.datetime(),
  }).strict()),
}).strict().superRefine((ledger, context) => {
  const people = new Set<string>(), operations = new Set<string>();
  let sequence = 0;
  for (const instruction of ledger.instructions) {
    if (instruction.sequence !== sequence + 1 || people.has(instruction.personId) || operations.has(instruction.operationId)) {
      context.addIssue({ code: "custom", message: "削除台帳の順序・重複を確認してください。" });
    }
    sequence = instruction.sequence; people.add(instruction.personId); operations.add(instruction.operationId);
  }
  if (sequence !== ledger.generation) context.addIssue({ code: "custom", message: "削除台帳の世代が一致しません。" });
});

export type RetentionPreview = z.infer<typeof retentionPreviewSchema>;
export type RetentionUpdateInput = z.infer<typeof retentionUpdateInputSchema>;
export type DeletionInput = z.infer<typeof deletionInputSchema>;
export type DeletionPreview = z.infer<typeof deletionPreviewSchema>;
export type DeletionStatus = z.infer<typeof deletionStatusSchema>;
export type PrivacyResponse = z.infer<typeof privacyResponseSchema>;
export type DiagnosticsResponse = z.infer<typeof diagnosticsResponseSchema>;
export type DeletionLedger = z.infer<typeof deletionLedgerSchema>;
