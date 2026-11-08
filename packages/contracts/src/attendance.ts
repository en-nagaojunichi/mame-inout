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
export const manualVisitInputSchema = z.object({ requestId: uuid.optional(), personId: uuid, enteredAt: inputDateTime, exitedAt: inputDateTime.nullable(), reason }).strict();
// HTTPからの追加では必須とし、通信切断後も同じIDの要求を二重登録しない。
export const manualVisitRequestInputSchema = manualVisitInputSchema.extend({ requestId: uuid });
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
const attendanceFilters = {
  q: z.string().trim().min(1).max(100).optional(),
  affiliation: z.string().trim().min(1).max(100).optional(),
  personId: uuid.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  // allは取消されていない全状態。取消済みの確認は明示的に切り替える。
  status: z.enum(["all", "inside", "completed", "canceled"]).default("all"),
  source: z.enum(["all", "RECEPTION", "MANUAL"]).default("all"),
  corrected: z.enum(["all", "true", "false"]).default("all"),
};
const validDateRange = (value: { from?: string; to?: string }) => !value.from || !value.to || value.from <= value.to;
export const attendanceQuerySchema = pageQuerySchema.extend(attendanceFilters).refine(validDateRange, { message: "開始日と終了日を確認してください。" });
export const attendanceCsvQuerySchema = z.object(attendanceFilters).strict().refine(validDateRange, { message: "開始日と終了日を確認してください。" });
export const presenceQuerySchema = pageQuerySchema.extend({ q: attendanceFilters.q, review: z.enum(["true", "false"]).optional() });
export const attendancePatchInputSchema = correctVisitInputSchema.omit({ visitId: true });
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
  total: z.number().int().nonnegative().optional(),
}).strict();
export const attendanceHistoryItemSchema = z.object({ id: uuid, person: visitPerson, enteredAt: utcDateTime, exitedAt: utcDateTime.nullable(), canceledAt: utcDateTime.nullable(), version: z.number().int().positive(), source: z.enum(["RECEPTION", "MANUAL"]), corrected: z.boolean().optional() }).strict();
export const attendanceHistoryResponseSchema = z.object({
  timeZone: timeZoneSchema,
  items: z.array(attendanceHistoryItemSchema).max(100),
  nextCursor: uuid.nullable(),
  asOf: utcDateTime.optional(),
  total: z.number().int().nonnegative().optional(),
}).strict();
export const attendanceRevisionSchema = z.object({
  id: uuid, createdAt: utcDateTime, actorName: z.string().nullable(), reason,
  before: z.union([visitDtoSchema, z.object({ state: z.literal("absent") }).strict()]),
  after: visitDtoSchema,
}).strict();
export const attendanceDetailResponseSchema = z.object({
  timeZone: timeZoneSchema, asOf: utcDateTime,
  visit: attendanceHistoryItemSchema.extend({ personId: uuid }),
  revisions: z.array(attendanceRevisionSchema).max(100), nextCursor: uuid.nullable(),
}).strict();
export const dashboardResponseSchema = z.object({
  timeZone: timeZoneSchema, asOf: utcDateTime,
  counts: z.object({ inside: z.number().int().nonnegative(), needsReview: z.number().int().nonnegative(), todayEntered: z.number().int().nonnegative(), todayExited: z.number().int().nonnegative() }).strict(),
  recent: z.array(attendanceHistoryItemSchema).max(8),
}).strict();
export const ATTENDANCE_CSV_LIMIT = 10_000;

export type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;
export type AttendanceCsvQuery = z.infer<typeof attendanceCsvQuerySchema>;
export type PresenceQuery = z.infer<typeof presenceQuerySchema>;
export type PresenceResponse = z.infer<typeof presenceResponseSchema>;
export type AttendanceHistoryItem = z.infer<typeof attendanceHistoryItemSchema>;
export type AttendanceHistoryResponse = z.infer<typeof attendanceHistoryResponseSchema>;
export type AttendanceDetailResponse = z.infer<typeof attendanceDetailResponseSchema>;
export type AttendancePatchInput = z.infer<typeof attendancePatchInputSchema>;
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

export type AttendanceMode = z.infer<typeof attendanceModeSchema>;
export type AttendanceOutcome = z.infer<typeof attendanceOutcomeSchema>;
export type AttendanceRecordInput = z.infer<typeof attendanceRecordInputSchema>;
export type AttendanceTicket = z.infer<typeof attendanceTicketSchema>;
export type AttendanceResult = z.infer<typeof attendanceResultSchema>;
export type AttendanceRequestResult = z.infer<typeof attendanceRequestResultSchema>;
export type ManualVisitInput = z.infer<typeof manualVisitInputSchema>;
export type CorrectVisitInput = z.infer<typeof correctVisitInputSchema>;
