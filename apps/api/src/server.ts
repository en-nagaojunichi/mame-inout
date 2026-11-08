import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createApp } from "./app.js";

try {
  const config = loadConfig();
  const db = createDatabase(config);
  await db.$queryRaw`SELECT 1`;
  const server = serve({ fetch: createApp(db, config).fetch, port: config.port, hostname: "0.0.0.0" });
  const stop = () => server.close(() => { void db.$disconnect().then(() => process.exit(0)); });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.info("APIを起動しました。");
} catch {
  console.error("APIを起動できません。設定、秘密ファイルの権限、DBの準備を確認してください。");
  process.exitCode = 1;
}
