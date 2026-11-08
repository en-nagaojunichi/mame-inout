import { defineConfig } from "prisma/config";

// クライアント生成は接続不要。移行は専用ローダーが資格情報を読む。
export default defineConfig({ schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations" } });
