import { writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { hash, newToken } from "./setup.js";

// 全パスキーを失った場合のホスト管理者専用入口。Webの無認証APIへは公開しない。
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("対話端末でサーバー管理者が実行してください。コードは表示しません。");
  process.exitCode = 1;
} else {
  const db = createDatabase(loadConfig());
  try {
    const [email, output] = process.argv.slice(2);
    if (!email || !output) throw new Error("メールアドレスと新規保存先が必要です。");
    const code = newToken();
    await db.$transaction(async (tx) => {
      const user = await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
      if (!user) throw new Error("管理者が見つかりません。");
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (current.role !== "ADMIN" || current.status !== "ACTIVE") throw new Error("有効な管理者が必要です。");
      // 新規ファイルのみ書き、既存の鍵や設定を上書きしない。生値を引数・ログへ出さない。
      await writeFile(output, code, { flag: "wx", mode: 0o600 });
      await tx.registrationAttempt.deleteMany({ where: { userId: user.id, kind: "RECOVER" } });
      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.recoveryCode.create({ data: { codeHash: hash(code), userId: user.id } });
      await tx.auditEvent.create({ data: { action: "SERVER_RECOVERY_CODE_ISSUED", actorType: "SYSTEM", actorUserId: user.id } });
    }, { timeout: 15_000 });
    console.info("復旧コードを指定ファイルへ保存しました。安全な端末で確認し、復旧完了後に削除してください。");
  } catch {
    console.error("復旧コードを発行できません。有効な管理者、未使用の保存先、DB接続を確認してください。");
    process.exitCode = 1;
  } finally { await db.$disconnect(); }
}
