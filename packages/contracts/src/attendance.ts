import { z } from "zod";

const uuid = z.uuid();
const utcDateTime = z.iso.datetime();
const inputDateTime = z.iso.datetime({ offset: true });

// 施設の時刻表示にはIANAタイムゾーンを使い、端末の既定時刻へ依存しない。
export const timeZoneSchema = z.string().min(1).max(100).refine((timeZone) => {
  try { new Intl.DateTimeFormat("ja-JP", { timeZone }).format(0); return true; } catch { return false; }
});
export const attendanceModeSchema = z.enum(["IN", "OUT"]);
export const attendanceOutcomeSchema = z.enum(["RECORDED", "ALREADY_INSIDE", "NOT_INSIDE", "QR_INVALID", "PERSON_UNAVAILABLE"]);
export const attendanceRecordInputSchema = z.object({
  requestId: uuid,
  mode: attendanceModeSchema,
  // URLや氏名をペイロードとして扱わず、専用形式だけを受け付ける。
  qr: z.string().regex(/^mio1_[A-Za-z0-9_-]{43}$/),
}).strict();
export const attendanceTicketSchema = z.object({ requestId: uuid, acceptUntil: utcDateTime, resultUntil: utcDateTime }).strict();
export const attendanceResultSchema = z.object({
  requestId: uuid,
  mode: attendanceModeSchema,
  outcome: attendanceOutcomeSchema,
  message: z.string().min(1),
  recordedAt: utcDateTime.nullable(),
  person: z.object({ displayName: z.string().min(1).max(100) }).strict().nullable(),
  timeZone: timeZoneSchema,
}).strict();
export const attendanceRequestResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending"), acceptUntil: utcDateTime }).strict(),
  z.object({ state: z.literal("completed"), result: attendanceResultSchema }).strict(),
]);
export const emptyRequestSchema = z.object({}).strict();

const reason = z.string().trim().min(1).max(500);
export const manualVisitInputSchema = z.object({ personId: uuid, enteredAt: inputDateTime, exitedAt: inputDateTime.nullable(), reason }).strict();
export const correctVisitInputSchema = z.object({
  visitId: uuid,
  expectedVersion: z.number().int().positive(),
  enteredAt: inputDateTime,
  exitedAt: inputDateTime.nullable(),
  cancel: z.boolean(),
  reason,
}).strict();
export const visitDtoSchema = z.object({ id: uuid, personId: uuid, enteredAt: utcDateTime, exitedAt: utcDateTime.nullable(), canceledAt: utcDateTime.nullable(), version: z.number().int().positive() }).strict();

export const pageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: uuid.optional() }).strict();
export const attendanceQuerySchema = pageQuerySchema.extend({ personId: uuid.optional() });
export const facilityResponseSchema = z.object({ id: z.literal(1), name: z.string().min(1).max(100), timeZone: timeZoneSchema }).strict();
export const personSummarySchema = z.object({
  id: uuid, displayName: z.string().min(1).max(100), phoneticName: z.string().nullable(), affiliation: z.string().nullable(), code: z.string().nullable(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]),
}).strict();
export const peopleResponseSchema = z.object({ items: z.array(personSummarySchema).max(100), nextCursor: uuid.nullable() }).strict();
const visitPerson = z.object({ id: uuid, displayName: z.string().min(1).max(100), affiliation: z.string().nullable() }).strict();
export const presenceResponseSchema = z.object({
  label: z.literal("記録上の在室者"), timeZone: timeZoneSchema, asOf: utcDateTime,
  items: z.array(z.object({ id: uuid, person: visitPerson, enteredAt: utcDateTime, elapsedSeconds: z.number().int().nonnegative(), needsReview: z.boolean(), version: z.number().int().positive() }).strict()).max(100),
  nextCursor: uuid.nullable(),
}).strict();
export const attendanceHistoryResponseSchema = z.object({
  timeZone: timeZoneSchema,
  items: z.array(z.object({ id: uuid, person: visitPerson, enteredAt: utcDateTime, exitedAt: utcDateTime.nullable(), canceledAt: utcDateTime.nullable(), version: z.number().int().positive(), source: z.enum(["RECEPTION", "MANUAL"]) }).strict()).max(100),
  nextCursor: uuid.nullable(),
}).strict();

export type AttendanceMode = z.infer<typeof attendanceModeSchema>;
export type AttendanceOutcome = z.infer<typeof attendanceOutcomeSchema>;
export type AttendanceRecordInput = z.infer<typeof attendanceRecordInputSchema>;
export type AttendanceTicket = z.infer<typeof attendanceTicketSchema>;
export type AttendanceResult = z.infer<typeof attendanceResultSchema>;
export type AttendanceRequestResult = z.infer<typeof attendanceRequestResultSchema>;
export type ManualVisitInput = z.infer<typeof manualVisitInputSchema>;
export type CorrectVisitInput = z.infer<typeof correctVisitInputSchema>;
