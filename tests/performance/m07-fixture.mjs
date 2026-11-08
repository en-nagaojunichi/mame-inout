import { createHmac, randomBytes, randomUUID, createHash } from "node:crypto";

const project = "mame-inout-test-m07";
const origin = "http://localhost:8085";
const token = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ensure = (condition) => { if (!condition) throw new Error("合成検査用DBの条件を満たしません。"); };
const mutableTables = ["User", "Session", "Account", "Verification", "Passkey", "SetupAttempt", "RateBucket", "AdminInvitation", "RegistrationAttempt", "RecoveryCode",
  "DeletionInstruction", "DeletionProgress", "Person", "QrCredential", "ReceptionDevice", "ReceptionCredential", "ReceptionApplication", "AttendanceVisit", "AttendanceRequest", "AttendanceRevision", "AuditEvent"];

// 申請途中の氏名・コードや保存設定も既存データとして拒否し、初期singleton以外は追加前に空を確認する。
export function validateEmptyState(value) {
  ensure(value && typeof value === "object" && Object.keys(value).sort().join(",") === "appearance,counts,facility,privacy,retention,setup,tables" &&
    value.counts && Object.keys(value.counts).sort().join(",") === [...mutableTables].sort().join(",") &&
    mutableTables.every((name) => value.counts[name] === 0));
  ensure(Array.isArray(value.tables) && value.tables.length === 27 && value.tables.every((name) => typeof name === "string") &&
    [...value.tables].sort().join(",") === [...mutableTables, "SetupState", "Facility", "Appearance", "PrivacyState", "RetentionPolicy", "SchemaMigration"].sort().join(","));
  const one = (name) => { ensure(Array.isArray(value[name]) && value[name].length === 1 && value[name][0].id === 1); return value[name][0]; };
  const setup = one("setup"), facility = one("facility"), appearance = one("appearance"), privacy = one("privacy"), retention = one("retention");
  ensure(setup.codeHash === null && setup.expiresAt === null && setup.completedAt === null);
  ensure(facility.name === "施設" && facility.timeZone === "Asia/Tokyo");
  ensure(appearance.displayName === "入退出管理システム" && appearance.icon === null && appearance.favicon === null && appearance.version === 1);
  ensure(privacy.generation === 0 && privacy.lastBackupAt === null && privacy.backupExternalConfirmed === false);
  ensure(typeof privacy.deploymentId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(privacy.deploymentId));
  ensure([facility.createdAt, facility.updatedAt, appearance.updatedAt].every((date) => date instanceof Date && Number.isFinite(date.getTime())));
  ensure(retention.days === 365 && retention.version === 1 && retention.backupRetentionDays === 30 && retention.lastRunAt === null &&
    retention.lastDeletedVisits === 0 && retention.lastDeletedAuditEvents === 0);
}

// Docker側の対象確認に加え、DBに触る側でも固定Origin・通常APIロール・明示指定を要求する。
// このモジュールの戻り値には一時資格を含む。呼出元はメモリだけで受け取り、表示・保存しない。
export async function runFixture(mode) {
  ensure(process.env.TEST_PROJECT === project && process.env.M07_BENCHMARK_ACK === "synthetic-only");
  const { loadConfig } = await import("/app/apps/api/dist/config.js");
  const { createDatabase } = await import("/app/apps/api/dist/db.js");
  const config = loadConfig();
  ensure(config.origin === origin && config.database.host === "db" && config.database.database === "mame" && config.database.user === "mame_app");
  const db = createDatabase({ ...config, database: { ...config.database, max: 1 } });
  try {
    const identity = await db.$queryRaw`SELECT current_database() AS database, current_user AS role`;
    ensure(identity[0]?.database === "mame" && identity[0]?.role === "mame_app");
    if (mode === "seed") {
      return await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Facility" WHERE id=1 FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "SetupState" WHERE id=1 FOR UPDATE`;
        const counts = Object.fromEntries(await Promise.all(mutableTables.map(async (name) => {
          // 識別子は上の固定表名だけ。呼出元や環境からSQLの表名を受け取らない。
          const rows = await tx.$queryRawUnsafe(`SELECT count(*)::integer AS count FROM "${name}"`);
          return [name, rows[0].count];
        })));
        const tables = await tx.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
        validateEmptyState({ counts, tables: tables.map((row) => row.tablename), setup: await tx.setupState.findMany(), facility: await tx.facility.findMany(),
          appearance: await tx.appearance.findMany(), privacy: await tx.privacyState.findMany(), retention: await tx.retentionPolicy.findMany() });
        const people = Array.from({ length: 500 }, (_, index) => ({ id: randomUUID(), displayName: `合成利用者${String(index + 1).padStart(4, "0")}`,
          affiliation: `合成グループ${String(index % 10 + 1).padStart(2, "0")}`, code: `SYNTH-${String(index + 1).padStart(4, "0")}` }));
        await tx.person.createMany({ data: people });
        const qrs = people.map(() => `mio1_${token()}`);
        await tx.qrCredential.createMany({ data: people.map((person, index) => ({ personId: person.id, tokenHash: hash(qrs[index]) })) });
        // 各人200日分の重ならない架空履歴を作る。最後の100人分だけ未退室とする。
        await tx.$executeRawUnsafe(`INSERT INTO "AttendanceVisit" (id,"personId","enteredAt","exitedAt","source","updatedAt")
          SELECT gen_random_uuid(), ($1::uuid[])[1+((n-1)%500)],
            timestamptz '2025-01-01 00:00:00+00' + ((n-1)/500)*interval '1 day' + ((n-1)%500)*interval '1 second',
            CASE WHEN n BETWEEN 99501 AND 99600 THEN NULL ELSE
              timestamptz '2025-01-01 01:00:00+00' + ((n-1)/500)*interval '1 day' + ((n-1)%500)*interval '1 second' END,
            'RECEPTION', clock_timestamp() FROM generate_series(1,100000) AS n`, people.map((person) => person.id));
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + 30 * 60_000);
        const administrator = await tx.user.create({ data: { id: randomUUID(), name: "合成性能検査管理者", email: "synthetic-performance@example.test", role: "ADMIN" } });
        const sessionToken = token();
        await tx.session.create({ data: { id: randomUUID(), userId: administrator.id, token: sessionToken, expiresAt, authenticatedAt: createdAt } });
        const signature = createHmac("sha256", config.secret).update(sessionToken).digest("base64");
        const adminCookie = `better-auth.session_token=${encodeURIComponent(`${sessionToken}.${signature}`)}`;
        const devices = [];
        for (let index = 0; index < 5; index++) {
          const device = await tx.receptionDevice.create({ data: { name: `合成受付${index + 1}`, status: "APPROVED", approvedAt: createdAt, expiresAt } });
          const credential = token();
          await tx.receptionCredential.create({ data: { deviceId: device.id, tokenHash: hash(credential), expiresAt } });
          devices.push({ cookie: `mame_reception=${credential}` });
        }
        await tx.setupState.update({ where: { id: 1 }, data: { completedAt: createdAt, codeHash: null, expiresAt: null } });
        return { adminCookie, devices, qrs };
      }, { timeout: 120_000 });
    }
    if (mode === "stats") {
      return (await db.$queryRaw`SELECT pg_database_size(current_database())::float8 AS "databaseBytes",
        count(*)::integer AS connections, count(*) FILTER (WHERE state='active')::integer AS "activeConnections"
        FROM pg_stat_activity WHERE datname=current_database()`)[0];
    }
    if (mode === "verify") {
      return (await db.$queryRaw`SELECT (SELECT count(*) FROM "Person")::integer AS people,
        (SELECT count(*) FROM "ReceptionDevice")::integer AS devices,
        (SELECT count(*) FROM "AttendanceVisit")::integer AS visits,
        (SELECT count(*) FROM "AttendanceVisit" WHERE "exitedAt" IS NULL AND "canceledAt" IS NULL)::integer AS inside,
        (SELECT count(*) FROM (SELECT "personId" FROM "AttendanceVisit" WHERE "exitedAt" IS NULL AND "canceledAt" IS NULL GROUP BY "personId" HAVING count(*)>1) q)::integer AS "duplicateOpen",
        (SELECT count(*) FROM "AttendanceVisit" WHERE "exitedAt"<"enteredAt")::integer AS "reversedTimes",
        (SELECT count(*) FROM "AttendanceRequest")::integer AS requests,
        (SELECT count(*) FROM "AttendanceRequest" WHERE "completedAt" IS NOT NULL)::integer AS "completedRequests",
        (SELECT count(*) FROM "AttendanceRequest" WHERE response->>'outcome'='RECORDED')::integer AS "recordedRequests",
        (SELECT count(*) FROM "AuditEvent" WHERE action='ATTENDANCE_RECORDED')::integer AS "recordedAudits"`)[0];
    }
    throw new Error("合成検査の処理が不正です。");
  } finally { await db.$disconnect(); }
}
