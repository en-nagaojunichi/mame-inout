import { z } from "zod";

const displayName = z.string().trim().min(1).max(100);
const email = z.email().max(254).transform((value) => value.toLowerCase());
const code = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const identityEmptyInputSchema = z.strictObject({});
export const invitationInputSchema = z.strictObject({ name: displayName, email });
export const invitationBeginInputSchema = z.strictObject({ code });
export const recoveryBeginInputSchema = z.strictObject({ email, code });
export const passkeyNameInputSchema = z.strictObject({ name: displayName });
export const administratorNameInputSchema = z.strictObject({ name: displayName });
export const mutationResponseSchema = z.strictObject({ ok: z.literal(true) });
export const invitationResponseSchema = z.strictObject({ code, expiresAt: z.iso.datetime() });
export const registrationBeginResponseSchema = z.strictObject({ ok: z.literal(true), name: displayName, email });
export const recoveryCodesResponseSchema = z.strictObject({ codes: z.array(code).length(8) });
export const securityResponseSchema = z.strictObject({
  currentUserId: z.string(),
  passkeys: z.array(z.strictObject({ id: z.string(), name: z.string().nullable(), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable() })),
  recoveryConfigured: z.boolean(), recentAuth: z.boolean(),
  admins: z.array(z.strictObject({ id: z.string(), name: z.string(), email: z.email(), emailVerified: z.boolean(), status: z.enum(["ACTIVE", "DISABLED"]) })),
  adminsNextCursor: z.string().nullable().default(null),
});
export type SecurityResponse = z.infer<typeof securityResponseSchema>;
