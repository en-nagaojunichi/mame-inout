import type { Database } from "./db.js";
import { hash } from "./setup.js";

export async function allowAttempt(db: Database, scope: string, ip: string, limit: number, seconds: number) {
  const key = hash(`${scope}:${ip}`);
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateBucket" (key, count, "startedAt") VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN "RateBucket"."startedAt" < now() - make_interval(secs => ${seconds}) THEN 1 ELSE "RateBucket".count + 1 END,
      "startedAt" = CASE WHEN "RateBucket"."startedAt" < now() - make_interval(secs => ${seconds}) THEN now() ELSE "RateBucket"."startedAt" END
    RETURNING count`;
  await db.rateBucket.deleteMany({ where: { startedAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) } } });
  return (rows[0]?.count ?? limit + 1) <= limit;
}
