import { z } from "zod";
import { pageQuerySchema, personSummarySchema } from "./attendance.js";

// 空の任意項目をnullへ揃え、一意コードの未指定を空文字として重複判定しない。
const optionalText = (maximum: number) => z.string().trim().max(maximum).nullable().optional().transform((value) => value || null);
export const personInputSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  phoneticName: optionalText(100), affiliation: optionalText(100), code: optionalText(64),
}).strict();
const expectedVersion = z.number().int().positive();
export const personUpdateInputSchema = personInputSchema.extend({ expectedVersion }).strict();
export const personStatusInputSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]), expectedVersion }).strict();
export const qrIssueInputSchema = z.object({ expectedVersion }).strict();
export const peopleQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(), status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]).optional(),
}).strict();
export const personDetailSchema = personSummarySchema.extend({
  version: expectedVersion, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), qrActive: z.boolean(),
}).strict();
export const qrIssueResponseSchema = z.object({
  qr: z.string().regex(/^mio1_[A-Za-z0-9_-]{43}$/), personId: z.uuid(), version: expectedVersion, issuedAt: z.iso.datetime(),
}).strict();
export type PersonInput = z.input<typeof personInputSchema>;
export type PersonUpdateInput = z.input<typeof personUpdateInputSchema>;
export type PersonStatusInput = z.infer<typeof personStatusInputSchema>;
export type PeopleQuery = z.infer<typeof peopleQuerySchema>;
export type PersonDetail = z.infer<typeof personDetailSchema>;
export type QrIssueResponse = z.infer<typeof qrIssueResponseSchema>;
