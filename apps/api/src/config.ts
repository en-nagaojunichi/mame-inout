import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

const settingsSchema = z.object({
  APP_ORIGIN: z.url(),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().regex(/^[a-z][a-z0-9_]*$/).default("mame"),
  DB_USER: z.enum(["mame_app", "mame_migrate"]),
  DB_PASSWORD_FILE: z.string().min(1),
  AUTH_SECRET_FILE: z.string().min(1).optional(),
  PORT: z.coerce.number().int().default(3001),
});

export function readSecret(path: string): string {
  try {
    const stat = statSync(path);
    // Composeのファイル型secretはホストの権限を引き継ぐため、読取可否だけで済ませない。
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error();
    const value = readFileSync(path, "utf8").trim();
    if (value.length < 32 || value.includes("\n") || value.includes("\r")) throw new Error();
    return value;
  } catch {
    // OS例外にはパス等が含まれるため、固定文だけを呼出元へ渡す。
    throw new Error("秘密ファイルがない、空、または読取権限が不適切です。");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, migration = false) {
  const parsed = settingsSchema.safeParse(env);
  if (!parsed.success) throw new Error("必要な設定が不足しているか、形式が不正です。");
  const values = parsed.data;
  const origin = new URL(values.APP_ORIGIN);
  if (origin.origin !== values.APP_ORIGIN || origin.username || origin.password ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "localhost"))) {
    throw new Error("公開URLはHTTPSのOriginを指定してください。開発用localhostだけHTTPを利用できます。");
  }
  if (values.DB_USER !== (migration ? "mame_migrate" : "mame_app")) throw new Error("用途に合うDBロールが必要です。");
  if (!migration && !values.AUTH_SECRET_FILE) throw new Error("認証用の秘密ファイルが必要です。");
  return {
    origin: origin.origin, rpID: origin.hostname, secure: origin.protocol === "https:", port: values.PORT,
    secret: migration ? "" : readSecret(values.AUTH_SECRET_FILE!),
    database: { host: values.DB_HOST, port: values.DB_PORT, database: values.DB_NAME, user: values.DB_USER,
      password: readSecret(values.DB_PASSWORD_FILE), max: 10 },
  };
}
export type Config = ReturnType<typeof loadConfig>;
