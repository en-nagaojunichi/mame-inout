import { mkdirSync, readFileSync, writeFileSync, existsSync, chownSync, chmodSync } from "node:fs";
import { join } from "node:path";

// NTFSのモード値を本番の検査から除外せず、開発時だけLinux側へ600で写す。
const groups = {
  api: ["db_app_password", "auth_secret"],
  tests: ["db_app_password", "auth_secret", "db_maintenance_password"],
  migrate: ["db_migrate_password"],
  maintenance: ["db_maintenance_password"],
  db: ["db_admin_password", "db_app_password", "db_migrate_password", "db_backup_password", "db_maintenance_password"],
};
try {
  for (const [service, names] of Object.entries(groups)) {
    const directory = join("/prepared", service);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of names) {
      const value = readFileSync(join("/run/secrets", name));
      if (value.length < 32 || value.length > 4096) throw new Error();
      const target = join(directory, name);
      if (existsSync(target)) {
        // 元ファイルだけ変更してDB側の資格が更新されたと扱わない。
        if (!readFileSync(target).equals(value)) throw new Error();
      } else { writeFileSync(target, value, { flag: "wx", mode: 0o600 }); }
      chmodSync(target, 0o600); chownSync(target, 1000, 1000);
    }
    chmodSync(directory, 0o700); chownSync(directory, 1000, 1000);
  }
  console.info("開発用の秘密ファイルの受け渡しを確認しました。");
} catch {
  console.error("秘密ファイルを準備できません。既存値との不一致や保存先の権限を確認してください。");
  process.exitCode = 1;
}
