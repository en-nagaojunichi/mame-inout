import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT, ORIGIN, distribution, validateArguments, validateContainers, validateContext } from "../../scripts/benchmark-m07.mjs";
import { runFixture, validateEmptyState } from "./m07-fixture.mjs";

function containers() {
  return ["api", "db", "web", "proxy"].map((service, index) => ({
    Id: String(index + 1).repeat(64),
    Config: { Image: service === "db" ? "postgres:18.6-bookworm" : `synthetic-${service}:fixed`,
      Labels: { "com.docker.compose.project": PROJECT, "com.docker.compose.service": service },
      Env: [`APP_ORIGIN=${ORIGIN}`, "DB_HOST=db", "DB_NAME=mame", "DB_USER=mame_app"] },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: { Privileged: false, CapAdd: null, SecurityOpt: ["no-new-privileges:true"],
      NanoCpus: ["api", "db"].includes(service) ? 750_000_000 : 250_000_000,
      Memory: { api: 512, db: 1024, web: 384, proxy: 128 }[service] * 1024 ** 2,
      PortBindings: service === "proxy" ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8085" }] } : {} },
    Mounts: service === "db" ? [{ Type: "volume", Name: `${PROJECT}_db_data`, Destination: "/var/lib/postgresql" }] : [],
    NetworkSettings: { Networks: Object.fromEntries((service === "api" ? ["database", "edge"] : service === "db" ? ["database"] : ["edge"]).map((name) => [`${PROJECT}_${name}`, {}])) },
  }));
}

test("明示した合成検査と新規JSON出力の指定だけを受け付ける", () => {
  assert.equal(validateArguments(["--ack", "synthetic-only", "--output", "result.json"]), "result.json");
  for (const input of [[], ["--ack", "production", "--output", "result.json"], ["--ack", "synthetic-only", "--output", "result.txt"], ["--ack", "synthetic-only", "--output", "result.json", "extra"]]) {
    assert.throws(() => validateArguments(input));
  }
});

test("Windowsからは既知のローカルDocker Desktop endpointだけを許す", () => {
  const value = [{ Name: "desktop-linux", Endpoints: { docker: { Host: "npipe:////./pipe/dockerDesktopLinuxEngine" } } }];
  validateContext(value);
  for (const host of ["ssh://production", "tcp://127.0.0.1:2375", "unix:///remote.sock"]) {
    assert.throws(() => validateContext([{ ...value[0], Endpoints: { docker: { Host: host } } }]));
  }
});

test("専用DB・loopback・CPUメモリ制限を満たす4サービスを受け付ける", () => {
  assert.equal(Object.keys(validateContainers(containers())).length, 4);
});

test("fixture単独実行もDBモジュールを読む前に環境誤用を拒否する", async () => {
  const previous = process.env.TEST_PROJECT;
  try {
    process.env.TEST_PROJECT = "mame-inout-production";
    await assert.rejects(runFixture("seed"), /合成検査用DB/);
  } finally {
    if (previous === undefined) delete process.env.TEST_PROJECT;
    else process.env.TEST_PROJECT = previous;
  }
});

function emptyState() {
  const tables = ["User", "Session", "Account", "Verification", "Passkey", "SetupAttempt", "RateBucket", "AdminInvitation", "RegistrationAttempt", "RecoveryCode",
    "DeletionInstruction", "DeletionProgress", "Person", "QrCredential", "ReceptionDevice", "ReceptionCredential", "ReceptionApplication", "AttendanceVisit", "AttendanceRequest", "AttendanceRevision", "AuditEvent"];
  return { counts: Object.fromEntries(tables.map((name) => [name, 0])), tables: [...tables, "SetupState", "Facility", "Appearance", "PrivacyState", "RetentionPolicy", "SchemaMigration"],
    setup: [{ id: 1, codeHash: null, expiresAt: null, completedAt: null }],
    facility: [{ id: 1, name: "施設", timeZone: "Asia/Tokyo", createdAt: new Date(), updatedAt: new Date() }],
    appearance: [{ id: 1, displayName: "入退出管理システム", icon: null, favicon: null, version: 1, updatedAt: new Date() }],
    privacy: [{ id: 1, deploymentId: "12345678-1234-1234-1234-123456789abc", generation: 0, lastBackupAt: null, backupExternalConfirmed: false }],
    retention: [{ id: 1, days: 365, version: 1, backupRetentionDays: 30, lastRunAt: null, lastDeletedVisits: 0, lastDeletedAuditEvents: 0 }] };
}

test("初期singletonだけの空DBを受け付け、6表以外の申請途中データも拒否する", () => {
  validateEmptyState(emptyState());
  for (const table of Object.keys(emptyState().counts)) {
    const value = emptyState(); value.counts[table] = 1;
    assert.throws(() => validateEmptyState(value), undefined, table);
  }
});

test("空の件数集合・欠落・追加・undefined・負数を空DBとして受け付けない", () => {
  for (const change of [
    (value) => { value.counts = {}; }, (value) => { delete value.counts.SetupAttempt; },
    (value) => { value.counts.Unknown = 0; }, (value) => { value.counts.Verification = undefined; },
    (value) => { value.counts.Person = -1; }, (value) => { delete value.setup; }, (value) => { value.other = []; },
    (value) => { value.tables.push("ExistingCustomerData"); }, (value) => { value.tables[0] = value.tables[1]; },
  ]) { const value = emptyState(); change(value); assert.throws(() => validateEmptyState(value)); }
  assert.throws(() => validateEmptyState(undefined));
});

test("初期コード・完了状態・変更されたsingletonを既存データとして拒否する", () => {
  const cases = { setup: ["codeHash", "expiresAt", "completedAt"], facility: ["name", "timeZone", "createdAt"],
    appearance: ["displayName", "icon", "favicon", "version", "updatedAt"], privacy: ["deploymentId", "generation", "lastBackupAt", "backupExternalConfirmed"],
    retention: ["days", "version", "backupRetentionDays", "lastRunAt", "lastDeletedVisits", "lastDeletedAuditEvents"] };
  for (const [table, fields] of Object.entries(cases)) {
    for (const field of fields) { const value = emptyState(); value[table][0][field] = "existing"; assert.throws(() => validateEmptyState(value), undefined, `${table}.${field}`); }
    for (const rows of [[], [emptyState()[table][0], emptyState()[table][0]]]) {
      const value = emptyState(); value[table] = rows; assert.throws(() => validateEmptyState(value));
    }
  }
});

// 対象を取り違えた場合は、fixture作成やDB停止の前に拒否する境界を固定する。
const mutations = {
  "別project": (rows) => { rows[0].Config.Labels["com.docker.compose.project"] = "mame-inout-production"; },
  "回帰project": (rows) => { rows[1].Config.Labels["com.docker.compose.project"] = "mame-inout-test-m07-regression"; },
  "未知サービス": (rows) => { rows[0].Config.Labels["com.docker.compose.service"] = "worker"; },
  "重複サービス": (rows) => { rows.push(structuredClone(rows[0])); },
  "DB欠落": (rows) => { rows.splice(1, 1); },
  "未知ID": (rows) => { rows[0].Id = "other"; },
  "停止中": (rows) => { rows[0].State.Running = false; },
  "不健康": (rows) => { rows[1].State.Health.Status = "unhealthy"; },
  "特権": (rows) => { rows[0].HostConfig.Privileged = true; },
  "追加capability": (rows) => { rows[0].HostConfig.CapAdd = ["SYS_ADMIN"]; },
  "権限昇格抑止欠落": (rows) => { rows[0].HostConfig.SecurityOpt = []; },
  "socketマウント": (rows) => { rows[0].Mounts.push({ Source: "/var/run/docker.sock", Destination: "/socket" }); },
  "CPU無制限": (rows) => { rows[0].HostConfig.NanoCpus = 0; },
  "memory無制限": (rows) => { rows[1].HostConfig.Memory = 0; },
  "DB外部公開": (rows) => { rows[1].HostConfig.PortBindings = { "5432/tcp": [{ HostPort: "5432" }] }; },
  "全interface": (rows) => { rows[3].HostConfig.PortBindings["8080/tcp"][0].HostIp = "0.0.0.0"; },
  "別HTTPポート": (rows) => { rows[3].HostConfig.PortBindings["8080/tcp"][0].HostPort = "8086"; },
  "追加HTTPポート": (rows) => { rows[3].HostConfig.PortBindings["80/tcp"] = [{ HostPort: "80" }]; },
  "別DB製品": (rows) => { rows[1].Config.Image = "mysql:latest"; },
  "DB bindマウント": (rows) => { rows[1].Mounts[0].Type = "bind"; },
  "他project volume": (rows) => { rows[1].Mounts[0].Name = "production_db_data"; },
  "別公開URL": (rows) => { rows[0].Config.Env[0] = "APP_ORIGIN=https://example.test"; },
  "別DBホスト": (rows) => { rows[0].Config.Env[1] = "DB_HOST=host.docker.internal"; },
  "管理DB資格": (rows) => { rows[0].Config.Env[3] = "DB_USER=mame_owner"; },
  "共有network": (rows) => { rows[1].NetworkSettings.Networks = { shared: {} }; },
  "API追加network": (rows) => { rows[0].NetworkSettings.Networks.shared = {}; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`危険な対象設定を拒否する：${name}`, () => {
  const rows = containers(); mutate(rows);
  assert.throws(() => validateContainers(rows));
});

test("標本の少ないp95も順位法で示し、非2xxとタイムアウトを失敗へ数える", () => {
  const result = distribution([{ ms: 4, status: 200 }, { ms: 1, status: 201 }, { ms: 2, status: 429 }, { ms: 3, status: 0 }]);
  assert.deepEqual(result, { count: 4, p50Ms: 2, p95Ms: 4, maxMs: 4, successes: 2, errors: 2 });
  assert.equal(distribution([]).p95Ms, null);
});
