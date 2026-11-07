import { mkdir, open, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

// 再実行で既存資格を作り直さず、不足分だけを生成する。
const directory = resolve(process.argv[2] ?? "secrets");
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
for (const name of ["db_admin_password", "db_app_password", "db_migrate_password", "auth_secret"]) {
  try {
    const file = await open(resolve(directory, name), "wx", 0o600);
    try { await file.writeFile(randomBytes(48).toString("base64url")); } finally { await file.close(); }
  } catch (error) { if (error.code !== "EEXIST") throw error; }
}
if (process.platform === "win32") {
  const who = spawnSync("whoami.exe", [], { encoding: "utf8" });
  if (who.status !== 0) throw new Error("ファイル所有者を確認できません。");
  const acl = spawnSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `${who.stdout.trim()}:(OI)(CI)F`], { stdio: "ignore" });
  if (acl.status !== 0) throw new Error("秘密フォルダーのアクセス権を設定できません。");
}
console.info("開発用の秘密ファイルを準備しました。既存の値は保持しています。");
