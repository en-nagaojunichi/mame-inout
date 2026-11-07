import { writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { hash, newToken } from "./setup.js";

const db = createDatabase(loadConfig());
try {
  const output = process.argv[2];
  if (!output) throw new Error("保存先が必要です。");
  const code = newToken();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SetupState" WHERE id = 1 FOR UPDATE`;
    const state = await tx.setupState.findUniqueOrThrow({ where: { id: 1 } });
    if (state.completedAt) throw new Error("初期設定済みです。");
    // 生値を標準出力へ流さず、明示した新規ファイルにだけ保存する。
    await writeFile(output, code, { flag: "wx", mode: 0o600 });
    await tx.setupState.update({ where: { id: 1 }, data: { codeHash: hash(code), expiresAt: new Date(Date.now() + 15 * 60_000) } });
    await tx.setupAttempt.deleteMany();
  });
  console.info("初期設定コードを指定ファイルに保存しました。有効期限は15分です。");
} catch {
  console.error("コードを発行できません。初期設定の状態、未使用の保存先、DB接続を確認してください。");
  process.exitCode = 1;
} finally { await db.$disconnect(); }
