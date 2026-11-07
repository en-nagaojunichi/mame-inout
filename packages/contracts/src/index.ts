import { z } from "zod";

// DBモデルや秘密値を公開せず、画面とAPIで入力と応答だけを共有する。
export const setupInputSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254).transform((value) => value.toLowerCase()),
}).strict();

export const adminResponseSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), emailVerified: z.boolean() }),
  database: z.literal("connected"),
});
export type AdminResponse = z.infer<typeof adminResponseSchema>;
export type ApiError = { code: string; message: string };
