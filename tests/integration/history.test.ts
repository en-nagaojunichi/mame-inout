import { afterAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import {
  attendanceDetailResponseSchema, attendanceHistoryResponseSchema, dashboardResponseSchema, presenceResponseSchema,
} from "@mame/contracts";
import { createDatabase, type Database } from "../../apps/api/src/db.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createApp } from "../../apps/api/src/app.js";
import { hash, newToken } from "../../apps/api/src/setup.js";
import { correctAttendanceVisit, createManualVisit } from "../../apps/api/src/attendance.js";
import { exportAttendanceCsv } from "../../apps/api/src/attendance-query.js";

// 監査を含む架空の業務記録は、隔離した使い捨てDBだけへ保存する。
if (!/^mame-inout-test(?:-|$)/.test(process.env.TEST_PROJECT ?? "")) throw new Error("独立したテスト用Composeプロジェクトが必要です。");
const config = loadConfig();
const db = createDatabase(config);
const app = createApp(db, config);
const users: string[] = [];
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

async function admin(recent = true, role = "ADMIN") {
  try {
    const user = await db.user.create({ data: { id: randomUUID(), name: "履歴確認の管理者", email: `${randomUUID()}@example.test`, role } });
    users.push(user.id);
    const token = newToken();
    const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, token,
      expiresAt: new Date(Date.now() + 600_000), authenticatedAt: new Date(Date.now() - (recent ? 0 : 360_000)) } });
    const signature = createHmac("sha256", config.secret).update(token).digest("base64");
    return { actor: { userId: user.id, sessionId: session.id }, cookie: `${config.secure ? "__Secure-" : ""}better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` };
  } catch { throw new Error("履歴試験の管理者を準備できませんでした。"); }
}

async function person(displayName = `履歴-${randomUUID()}`, affiliation?: string, code?: string) {
  return db.person.create({ data: { displayName, ...(affiliation === undefined ? {} : { affiliation }), ...(code === undefined ? {} : { code }) } });
}
async function visit(personId: string, enteredAt = "2024-01-01T00:00:00Z", exitedAt: string | null = "2024-01-01T01:00:00Z", canceledAt?: Date) {
  return db.attendanceVisit.create({ data: { personId, enteredAt: new Date(enteredAt), exitedAt: exitedAt ? new Date(exitedAt) : null, ...(canceledAt ? { canceledAt } : {}) } });
}
function api(path: string, cookie?: string, body?: unknown, method = body === undefined ? "GET" : "POST", origin = config.origin) {
  return app.request(path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function fields(record: { enteredAt: Date; exitedAt: Date | null; version: number }) {
  return { enteredAt: record.enteredAt.toISOString(), exitedAt: record.exitedAt?.toISOString() ?? null, expectedVersion: record.version, cancel: false, reason: "実際の記録を確認した訂正" };
}
async function errorCode(action: () => Promise<unknown>) {
  try { await action(); return null; } catch (error) { return (error as { code?: unknown }).code; }
}
async function history(path: string, cookie: string) {
  const response = await api(path, cookie);
  expect(response.status).toBe(200);
  return attendanceHistoryResponseSchema.parse(await response.json());
}
async function csv(path: string, cookie: string) {
  const response = await api(path, cookie);
  expect(response.status).toBe(200);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
}
function readCsv(text: string) {
  // 出力本文を読み戻し、カンマ・引用符・改行が別セルへ崩れていないことを確認する。
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  const value = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\r" && value[index + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; index++; }
    else cell += character;
  }
  expect(quoted).toBe(false); expect(row).toEqual([]); expect(cell).toBe("");
  return rows;
}

describe("管理ホーム・在室・履歴APIの権限", () => {
  it("未認証・受付端末・管理者以外へ一覧・詳細・CSV・訂正を渡さない", async () => {
    const token = newToken();
    const device = await db.receptionDevice.create({ data: { name: "履歴権限確認の端末", status: "APPROVED", approvedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) } });
    await db.receptionCredential.create({ data: { deviceId: device.id, tokenHash: hash(token), expiresAt: device.expiresAt! } });
    const other = await admin(true, "VIEWER");
    const receptionCookie = `${config.secure ? "__Secure-mame-reception" : "mame_reception"}=${token}`;
    for (const [cookie, status] of [[undefined, 401], [receptionCookie, 403], [other.cookie, 403]] as const) {
      for (const path of ["dashboard", "presence", "attendance", `attendance/${randomUUID()}`, "attendance.csv"]) {
        const result = await api(`/api/admin/${path}`, cookie);
        expect(result.status).toBe(status); expect(result.headers.get("cache-control")).toBe("no-store");
      }
      expect((await api("/api/admin/attendance", cookie, {})).status).toBe(status);
      expect((await api(`/api/admin/attendance/${randomUUID()}`, cookie, {}, "PATCH")).status).toBe(status);
    }
  });

  it("再認証が古い管理者は読取可能だが、追加・訂正・CSVは再認証を要求する", async () => {
    const manager = await admin(false), target = await person();
    const record = await visit(target.id);
    expect((await api("/api/admin/dashboard", manager.cookie)).status).toBe(200);
    expect((await api(`/api/admin/attendance/${record.id}`, manager.cookie)).status).toBe(200);
    for (const response of [await api("/api/admin/attendance.csv", manager.cookie), await api("/api/admin/attendance", manager.cookie, {}), await api(`/api/admin/attendance/${record.id}`, manager.cookie, fields(record), "PATCH")]) {
      expect(response.status).toBe(403); expect((await response.json() as { code: string }).code).toBe("REAUTH_REQUIRED");
    }
    expect(await db.attendanceRevision.count({ where: { visitId: record.id } })).toBe(0);
  });

  it("ルート検査後に消えたセッションでも書込みTxとCSVを拒否する", async () => {
    const manager = await admin(), target = await person(), record = await visit(target.id);
    await db.session.delete({ where: { id: manager.actor.sessionId } });
    const input = { personId: target.id, enteredAt: "2024-01-02T00:00:00Z", exitedAt: "2024-01-02T01:00:00Z", reason: "失効後の試験" };
    expect(await errorCode(() => createManualVisit(db, manager.actor, input))).toBe("UNAUTHENTICATED");
    expect(await errorCode(() => correctAttendanceVisit(db, manager.actor, { ...fields(record), visitId: record.id }))).toBe("UNAUTHENTICATED");
    expect(await errorCode(() => exportAttendanceCsv(db, manager.actor, { status: "all", source: "all", corrected: "all", personId: target.id }))).toBe("UNAUTHENTICATED");
  });

  it.each(["session", "recent"] as const)("利用者の実ロック待機後に%s期限が切れた手動追加を拒否する", async (kind) => {
    const manager = await admin(), target = await person();
    let acquired!: () => void; let unlock!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${target.id}::uuid FOR UPDATE`;
      acquired(); await release;
    }, { timeout: 15_000 });
    await locked;
    const changing = errorCode(() => createManualVisit(db, manager.actor, { requestId: randomUUID(), personId: target.id,
      enteredAt: "2024-02-01T00:00:00Z", exitedAt: null, reason: "期限切れで確定しない" }));
    try {
      let observed = false;
      for (let index = 0; index < 50; index++) {
        const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE usename = current_user AND wait_event_type = 'Lock' AND query LIKE '%Person%' AND query LIKE '%FOR UPDATE%') AS waiting`;
        if (rows[0]?.waiting) { observed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observed).toBe(true);
      await db.session.update({ where: { id: manager.actor.sessionId }, data: kind === "recent" ? { authenticatedAt: new Date(Date.now() - 360_000) } : { expiresAt: new Date(Date.now() - 60_000) } });
    } finally { unlock(); await blocker; }
    expect(await changing).toBe(kind === "recent" ? "REAUTH_REQUIRED" : "UNAUTHENTICATED");
    expect(await db.attendanceVisit.count({ where: { personId: target.id } })).toBe(0);
  });

  it("異なるOriginからの変更とCSV取得を拒否する", async () => {
    const manager = await admin();
    for (const response of [await api("/api/admin/attendance.csv", manager.cookie, undefined, "GET", "https://example.invalid"), await api("/api/admin/attendance", manager.cookie, {}, "POST", "https://example.invalid")]) expect(response.status).toBe(403);
  });
});

describe("施設時刻による在室・履歴の検索", () => {
  it("氏名・所属・コードを検索し、LIKEの%と_を文字として扱う", async () => {
    const manager = await admin(), marker = `検索${randomUUID()}`;
    const first = await person(`${marker}%_`, `${marker}所属`, `${marker}コード`), second = await person(`${marker}別人`);
    const firstVisit = await visit(first.id); await visit(second.id);
    for (const term of [`${marker}%_`, `${marker}所属`, `${marker}コード`]) {
      const result = await history(`/api/admin/attendance?q=${encodeURIComponent(term)}`, manager.cookie);
      expect(result.items.map((item) => item.id)).toEqual([firstVisit.id]); expect(result.total).toBe(1);
    }
    expect((await history(`/api/admin/attendance?q=${encodeURIComponent("' OR true --")}`, manager.cookie)).total).toBe(0);
  });

  it("入室日を施設TZで判定し、開始・終了日の境界を含める", async () => {
    const manager = await admin(), target = await person();
    const previous = await visit(target.id, "2024-01-01T14:59:59Z", "2024-01-01T14:59:59Z");
    const start = await visit(target.id, "2024-01-01T15:00:00Z", "2024-01-01T15:00:00Z");
    const end = await visit(target.id, "2024-01-02T14:59:59Z", "2024-01-02T14:59:59Z");
    const next = await visit(target.id, "2024-01-02T15:00:00Z", "2024-01-02T15:00:00Z");
    const result = await history(`/api/admin/attendance?personId=${target.id}&from=2024-01-02&to=2024-01-02`, manager.cookie);
    expect(result.items.map((item) => item.id)).toEqual([end.id, start.id]);
    expect(result.items.some((item) => item.id === previous.id || item.id === next.id)).toBe(false);
    expect(result.timeZone).toBe("Asia/Tokyo");
  });

  it("夏時間開始日の23時間も施設の1日として検索する", async () => {
    const manager = await admin(), target = await person();
    const original = await db.facility.findUniqueOrThrow({ where: { id: 1 } });
    try {
      await db.facility.update({ where: { id: 1 }, data: { timeZone: "America/New_York" } });
      const first = await visit(target.id, "2024-03-10T05:00:00Z", "2024-03-10T05:00:00Z");
      const last = await visit(target.id, "2024-03-11T03:59:59Z", "2024-03-11T03:59:59Z");
      await visit(target.id, "2024-03-11T04:00:00Z", "2024-03-11T04:00:00Z");
      const result = await history(`/api/admin/attendance?personId=${target.id}&from=2024-03-10&to=2024-03-10`, manager.cookie);
      expect(result.items.map((item) => item.id)).toEqual([last.id, first.id]);
    } finally { await db.facility.update({ where: { id: 1 }, data: { timeZone: original.timeZone } }); }
  });

  it("在室・終了・取消を分け、通常の履歴へ取消を含めない", async () => {
    const manager = await admin(), target = await person();
    const completed = await visit(target.id), canceled = await visit(target.id, "2024-01-02T00:00:00Z", "2024-01-02T01:00:00Z", new Date());
    const inside = await visit(target.id, "2024-01-03T00:00:00Z", null);
    for (const [status, ids] of [["all", [inside.id, completed.id]], ["inside", [inside.id]], ["completed", [completed.id]], ["canceled", [canceled.id]]] as const) {
      expect((await history(`/api/admin/attendance?personId=${target.id}&status=${status}`, manager.cookie)).items.map((item) => item.id)).toEqual(ids);
    }
  });

  it("所属・記録方法・訂正有無を区別し、通常退室の版更新を訂正と誤認しない", async () => {
    const manager = await admin(), target = await person(undefined, `所属-${randomUUID()}`);
    const manual = await createManualVisit(db, manager.actor, { personId: target.id, enteredAt: "2024-01-01T00:00:00Z", exitedAt: "2024-01-01T01:00:00Z", reason: "追加" });
    const qr = await visit(target.id, "2024-01-02T00:00:00Z", "2024-01-02T01:00:00Z");
    await db.attendanceVisit.update({ where: { id: qr.id }, data: { version: 2 } });
    const untouched = await createManualVisit(db, manager.actor, { personId: target.id, enteredAt: "2024-01-03T00:00:00Z", exitedAt: "2024-01-03T01:00:00Z", reason: "追加のみ" });
    await correctAttendanceVisit(db, manager.actor, { visitId: manual.id, expectedVersion: manual.version, enteredAt: manual.enteredAt, exitedAt: manual.exitedAt, cancel: false, reason: "内容を訂正した" });
    for (const [filter, id] of [["source=MANUAL&corrected=true", manual.id], ["source=RECEPTION&corrected=false", qr.id], ["source=MANUAL&corrected=false", untouched.id]]) {
      const query = `personId=${target.id}&affiliation=${encodeURIComponent(target.affiliation!)}&${filter}`;
      const result = await history(`/api/admin/attendance?${query}`, manager.cookie);
      expect(result.items.map((item) => item.id)).toEqual([id]);
      expect(result.items[0]!.corrected).toBe(id === manual.id);
      const text = await csv(`/api/admin/attendance.csv?${query}`, manager.cookie);
      expect(text.includes(id!)).toBe(true);
      expect(text.includes(id === manual.id ? '"訂正あり"' : '"訂正なし"')).toBe(true);
    }
  });

  it("同時刻の履歴も重複せず降順ページングし、他条件のカーソルを拒否する", async () => {
    const manager = await admin(), target = await person();
    const records = await Promise.all(Array.from({ length: 5 }, () => visit(target.id, "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z")));
    const observed: string[] = []; let cursor: string | null = null;
    do {
      const result = await history(`/api/admin/attendance?personId=${target.id}&limit=2${cursor ? `&cursor=${cursor}` : ""}`, manager.cookie);
      observed.push(...result.items.map((item) => item.id)); cursor = result.nextCursor;
      expect(result.total).toBe(5);
    } while (cursor);
    expect(observed).toEqual(records.map((row) => row.id).sort().reverse());
    expect((await api(`/api/admin/attendance?personId=${randomUUID()}&cursor=${records[0]!.id}`, manager.cookie)).status).toBe(409);
  });

  it("DBにマイクロ秒がある履歴でもページ境界で行を飛ばさない", async () => {
    const manager = await admin(), target = await person(), ids = Array.from({ length: 3 }, () => randomUUID());
    for (const id of ids) await db.$executeRaw`INSERT INTO "AttendanceVisit" (id, "personId", "enteredAt", "exitedAt")
      VALUES (${id}::uuid, ${target.id}::uuid, '2024-01-01T00:00:00.123456Z'::timestamptz, '2024-01-01T01:00:00Z'::timestamptz)`;
    let cursor: string | null = null; const observed: string[] = [];
    do {
      const result = await history(`/api/admin/attendance?personId=${target.id}&limit=1${cursor ? `&cursor=${cursor}` : ""}`, manager.cookie);
      observed.push(...result.items.map((item) => item.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(observed).toEqual(ids.sort().reverse());
  });

  it("DBにマイクロ秒がある在室でもページ境界で行を飛ばさない", async () => {
    const manager = await admin(), marker = `微秒在室-${randomUUID()}`, ids = Array.from({ length: 3 }, () => randomUUID());
    for (const id of ids) {
      const target = await person(marker);
      await db.$executeRaw`INSERT INTO "AttendanceVisit" (id, "personId", "enteredAt") VALUES (${id}::uuid, ${target.id}::uuid, '2024-01-01T00:00:00.123456Z'::timestamptz)`;
    }
    let cursor: string | null = null; const observed: string[] = [];
    do {
      const response = await api(`/api/admin/presence?q=${encodeURIComponent(marker)}&limit=1${cursor ? `&cursor=${cursor}` : ""}`, manager.cookie);
      const result = presenceResponseSchema.parse(await response.json());
      observed.push(...result.items.map((item) => item.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(observed).toEqual(ids.sort());
  });

  it("不正な期間・検索・状態・ページサイズを拒否する", async () => {
    const manager = await admin();
    for (const query of ["from=2024-02-30", "from=2024-03-02&to=2024-03-01", "status=unknown", "limit=101", "limit=0", "cursor=invalid", "unused=true", `q=${"a".repeat(101)}`]) expect((await api(`/api/admin/attendance?${query}`, manager.cookie)).status).toBe(422);
    expect((await api("/api/admin/presence?review=maybe", manager.cookie)).status).toBe(422);
    expect((await api("/api/admin/attendance.csv?limit=20", manager.cookie)).status).toBe(422);
  });

  it("管理ホームの人数を実記録と照合し、取消を集計しない", async () => {
    const manager = await admin(), target = await person();
    await visit(target.id, new Date(Date.now() - 600_000).toISOString(), null);
    const response = await api("/api/admin/dashboard", manager.cookie);
    expect(response.status).toBe(200);
    const result = dashboardResponseSchema.parse(await response.json());
    expect(result.counts.inside).toBe(await db.attendanceVisit.count({ where: { canceledAt: null, exitedAt: null, person: { facilityId: 1 } } }));
    expect(result.counts.needsReview).toBeGreaterThanOrEqual(0); expect(result.counts.needsReview).toBeLessThanOrEqual(result.counts.inside);
    // ほかの試験で新しい記録が作られていても、特定fixtureが最近8件へ入るとは仮定しない。
    // 入室と退室の遅い方で並べたDBの実データと、人数だけでなく表示内容・順序も照合する。
    const expected = await db.$queryRaw<Array<{ id: string; personId: string; displayName: string; affiliation: string | null;
      enteredAt: Date; exitedAt: Date | null; canceledAt: Date | null; version: number; source: string }>>`
      SELECT v.id, p.id AS "personId", p."displayName", p.affiliation, v."enteredAt", v."exitedAt", v."canceledAt", v.version, v.source
      FROM "AttendanceVisit" v JOIN "Person" p ON p.id = v."personId"
      WHERE p."facilityId" = 1 AND v."canceledAt" IS NULL
      ORDER BY CASE WHEN v."exitedAt" > v."enteredAt" THEN v."exitedAt" ELSE v."enteredAt" END DESC, v.id DESC LIMIT 8`;
    const items = await Promise.all(expected.map(async (row) => ({ id: row.id, person: { id: row.personId, displayName: row.displayName, affiliation: row.affiliation },
      enteredAt: row.enteredAt.toISOString(), exitedAt: row.exitedAt?.toISOString() ?? null, canceledAt: row.canceledAt?.toISOString() ?? null,
      version: row.version, source: row.source,
      corrected: await db.attendanceRevision.count({ where: { visitId: row.id, NOT: { before: { equals: { state: "absent" } } } } }) > 0 })));
    expect(result.recent).toEqual(items);
    expect(result.recent.every((item) => Date.parse(item.enteredAt) <= Date.parse(result.asOf) && (!item.exitedAt || Date.parse(item.exitedAt) <= Date.parse(result.asOf)))).toBe(true);
  });

  it("12時間未満でも施設日を跨いだ在室を要確認にし、自動退室しない", async () => {
    const manager = await admin(), target = await person();
    const original = await db.facility.findUniqueOrThrow({ where: { id: 1 } });
    const time = new Date();
    const zone = ["UTC", "Asia/Tokyo", "Pacific/Honolulu", "Europe/London"].find((timeZone) => Number(new Intl.DateTimeFormat("en", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(time)) < 11)!;
    try {
      await db.facility.update({ where: { id: 1 }, data: { timeZone: zone } });
      // 11時間前なら、上で選んだTZでは前日かつ12時間未満になる。
      const record = await visit(target.id, new Date(time.getTime() - 11 * 3_600_000).toISOString(), null);
      const response = await api(`/api/admin/presence?q=${encodeURIComponent(target.displayName)}&review=true`, manager.cookie);
      expect(response.status).toBe(200);
      const result = presenceResponseSchema.parse(await response.json());
      expect(result.items.map((item) => item.id)).toEqual([record.id]); expect(result.items[0]!.needsReview).toBe(true);
      expect((await db.attendanceVisit.findUniqueOrThrow({ where: { id: record.id } })).exitedAt).toBeNull();
    } finally { await db.facility.update({ where: { id: 1 }, data: { timeZone: original.timeZone } }); }
  });

  it("在室検索・ページングと要確認だけの検索が一致する", async () => {
    const manager = await admin(), marker = `在室${randomUUID()}`, target = await person(marker);
    const record = await visit(target.id, "2020-01-01T00:00:00Z", null);
    const response = await api(`/api/admin/presence?q=${encodeURIComponent(marker)}&limit=1&review=true`, manager.cookie);
    const result = presenceResponseSchema.parse(await response.json());
    expect(result.total).toBe(1); expect(result.items[0]!.id).toBe(record.id); expect(result.nextCursor).toBeNull();
    const normal = presenceResponseSchema.parse(await (await api(`/api/admin/presence?q=${encodeURIComponent(marker)}&review=false`, manager.cookie)).json());
    expect(normal.total).toBe(0); expect(normal.items).toEqual([]);
  });
});

describe("手動追加・訂正・取消と変更履歴", () => {
  it("手動追加から訂正・取消まで前後・理由・実行者を追記して保持する", async () => {
    const manager = await admin(), target = await person();
    const created = await api("/api/admin/attendance", manager.cookie, { requestId: randomUUID(), personId: target.id, enteredAt: "2024-01-01T09:00:00+09:00", exitedAt: null, reason: "入室を後から確認" });
    expect(created.status).toBe(201);
    const first = await created.json() as { id: string; enteredAt: string; version: number };
    const patch = { expectedVersion: first.version, enteredAt: first.enteredAt, exitedAt: "2024-01-01T10:00:00+09:00", cancel: false, reason: "退室を確認" };
    const changed = await api(`/api/admin/attendance/${first.id}`, manager.cookie, patch, "PATCH"); expect(changed.status).toBe(200);
    const second = await changed.json() as { version: number };
    const canceled = await api(`/api/admin/attendance/${first.id}`, manager.cookie, { ...patch, expectedVersion: second.version, cancel: true, reason: "誤った日付のため取消" }, "PATCH");
    expect(canceled.status).toBe(200);
    const detail = attendanceDetailResponseSchema.parse(await (await api(`/api/admin/attendance/${first.id}?limit=2`, manager.cookie)).json());
    expect(detail.visit.source).toBe("MANUAL"); expect(detail.visit.version).toBe(3); expect(detail.visit.canceledAt).not.toBeNull();
    expect(detail.revisions.map((revision) => revision.reason)).toEqual(["誤った日付のため取消", "退室を確認"]);
    expect(detail.revisions.every((revision) => revision.actorName === "履歴確認の管理者")).toBe(true);
    const last = attendanceDetailResponseSchema.parse(await (await api(`/api/admin/attendance/${first.id}?cursor=${detail.nextCursor}`, manager.cookie)).json());
    expect(last.revisions[0]!.before).toEqual({ state: "absent" }); expect(last.nextCursor).toBeNull();
    expect((await history(`/api/admin/attendance?personId=${target.id}`, manager.cookie)).total).toBe(0);
    expect((await history(`/api/admin/attendance?personId=${target.id}&status=canceled`, manager.cookie)).total).toBe(1);
    expect((await csv(`/api/admin/attendance.csv?personId=${target.id}&status=canceled`, manager.cookie)).includes('"取消"')).toBe(true);
  });

  it("古い版の訂正を拒否し、最新の記録と履歴を上書きしない", async () => {
    const manager = await admin(), target = await person(), record = await visit(target.id);
    const input = fields(record);
    expect((await api(`/api/admin/attendance/${record.id}`, manager.cookie, input, "PATCH")).status).toBe(200);
    const response = await api(`/api/admin/attendance/${record.id}`, manager.cookie, { ...input, reason: "古い画面" }, "PATCH");
    expect(response.status).toBe(409); expect((await response.json() as { code: string }).code).toBe("VERSION_CONFLICT");
    expect(await db.attendanceRevision.count({ where: { visitId: record.id } })).toBe(1);
  });

  it("取消済みの記録は再有効化も再取消も拒否する", async () => {
    const manager = await admin(), target = await person(), record = await visit(target.id, undefined, undefined, new Date());
    for (const cancel of [false, true]) {
      const response = await api(`/api/admin/attendance/${record.id}`, manager.cookie, { ...fields(record), cancel }, "PATCH");
      expect(response.status).toBe(409); expect((await response.json() as { code: string }).code).toBe("VISIT_CANCELED");
    }
    expect(await db.attendanceRevision.count({ where: { visitId: record.id } })).toBe(0);
  });

  it("空理由・未来・逆転・重複・不正項目・存在しない記録をAPIでも拒否する", async () => {
    const manager = await admin(), target = await person(), record = await visit(target.id);
    const input = { requestId: randomUUID(), personId: target.id, enteredAt: "2024-01-01T00:00:00Z", exitedAt: "2024-01-01T01:00:00Z", reason: "手動試験" };
    for (const [change, status] of [[{ reason: " " }, 422], [{ enteredAt: "2099-01-01T00:00:00Z" }, 422], [{ exitedAt: "2023-01-01T00:00:00Z" }, 422], [{}, 409], [{ actorUserId: randomUUID() }, 422]] as const) {
      expect((await api("/api/admin/attendance", manager.cookie, { ...input, ...change })).status).toBe(status);
    }
    expect((await api(`/api/admin/attendance/${randomUUID()}`, manager.cookie, fields(record), "PATCH")).status).toBe(404);
    expect((await api(`/api/admin/attendance/${randomUUID()}`, manager.cookie)).status).toBe(404);
    expect((await api("/api/admin/attendance/invalid", manager.cookie)).status).toBe(422);
  });

  it("同じ手動追加の再送を重複保存せず、結果不明の確認に使える記録を1件だけ残す", async () => {
    const manager = await admin(), target = await person();
    const input = { requestId: randomUUID(), personId: target.id, enteredAt: "2024-02-01T00:00:00Z", exitedAt: "2024-02-01T01:00:00Z", reason: "再送の検証" };
    const responses = await Promise.all([api("/api/admin/attendance", manager.cookie, input), api("/api/admin/attendance", manager.cookie, input)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect((await history(`/api/admin/attendance?personId=${target.id}`, manager.cookie)).total).toBe(1);
    expect(await db.attendanceRevision.count({ where: { visitId: input.requestId } })).toBe(1);
  });

  it("入退室が同時刻の手動記録も、同じ追加の再送で増やさない", async () => {
    const manager = await admin(), target = await person();
    const input = { requestId: randomUUID(), personId: target.id, enteredAt: "2024-02-01T00:00:00Z", exitedAt: "2024-02-01T00:00:00Z", reason: "同時刻記録の再送試験" };
    const responses = await Promise.all([api("/api/admin/attendance", manager.cookie, input), api("/api/admin/attendance", manager.cookie, input)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect((await history(`/api/admin/attendance?personId=${target.id}`, manager.cookie)).total).toBe(1);
  });

  it("追加後に訂正されても、同じ要求の再送には最初の応答を返す", async () => {
    const manager = await admin(), target = await person();
    const input = { requestId: randomUUID(), personId: target.id, enteredAt: "2024-02-01T00:00:00Z", exitedAt: null, reason: "初回追加" };
    const first = await (await api("/api/admin/attendance", manager.cookie, input)).json() as { version: number };
    const changed = await api(`/api/admin/attendance/${input.requestId}`, manager.cookie, { expectedVersion: first.version, enteredAt: input.enteredAt, exitedAt: "2024-02-01T01:00:00Z", cancel: false, reason: "退室が確認できた" }, "PATCH");
    expect(changed.status).toBe(200);
    const repeated = await api("/api/admin/attendance", manager.cookie, input);
    expect(repeated.status).toBe(201); expect(await repeated.json()).toEqual(first);
    expect((await db.attendanceVisit.findUniqueOrThrow({ where: { id: input.requestId } })).version).toBe(2);
    expect(await db.attendanceRevision.count({ where: { visitId: input.requestId } })).toBe(2);
  });

  it("同じ追加要求IDの別内容・別管理者・別利用者を拒否する", async () => {
    const manager = await admin(), other = await admin(), target = await person(), another = await person();
    const input = { requestId: randomUUID(), personId: target.id, enteredAt: "2024-02-01T00:00:00Z", exitedAt: null, reason: "要求の固定" };
    expect((await api("/api/admin/attendance", manager.cookie, input)).status).toBe(201);
    for (const [cookie, data] of [[manager.cookie, { ...input, reason: "別理由" }], [manager.cookie, { ...input, personId: another.id }], [other.cookie, input]] as const) {
      const response = await api("/api/admin/attendance", cookie, data);
      expect(response.status).toBe(409); expect((await response.json() as { code: string }).code).toBe("REQUEST_CONFLICT");
    }
    expect(await db.attendanceVisit.count({ where: { id: input.requestId } })).toBe(1);
  });

  it("別管理者・別利用者で同じ要求IDが衝突しても一意制約で1件にする", async () => {
    const first = await admin(), second = await admin(), firstPerson = await person(), secondPerson = await person(), requestId = randomUUID();
    const request = { requestId, enteredAt: "2024-02-01T00:00:00Z", exitedAt: "2024-02-01T00:00:00Z", reason: "要求IDの同時衝突" };
    const results = await Promise.all([api("/api/admin/attendance", first.cookie, { ...request, personId: firstPerson.id }), api("/api/admin/attendance", second.cookie, { ...request, personId: secondPerson.id })]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await db.attendanceVisit.count({ where: { id: requestId } })).toBe(1);
    expect(await db.attendanceRevision.count({ where: { visitId: requestId } })).toBe(1);
  });

  it("変更履歴のカーソルを他の記録へ流用できない", async () => {
    const manager = await admin(), first = await person(), second = await person();
    const initial = await createManualVisit(db, manager.actor, { personId: first.id, enteredAt: "2024-01-01T00:00:00Z", exitedAt: null, reason: "最初の記録" });
    const revision = await db.attendanceRevision.findFirstOrThrow({ where: { visitId: initial.id } });
    const other = await visit(second.id);
    expect((await api(`/api/admin/attendance/${other.id}?cursor=${revision.id}`, manager.cookie)).status).toBe(409);
  });

  it("変更履歴のマイクロ秒を丸めずページ分割する", async () => {
    const manager = await admin(), target = await person(), record = await visit(target.id), ids = Array.from({ length: 3 }, () => randomUUID());
    const data = JSON.stringify({ id: record.id, personId: target.id, enteredAt: record.enteredAt.toISOString(), exitedAt: record.exitedAt!.toISOString(), canceledAt: null, version: 1 });
    for (const id of ids) await db.$executeRaw`INSERT INTO "AttendanceRevision" (id, "visitId", "actorUserId", reason, before, after, "createdAt")
      VALUES (${id}::uuid, ${record.id}::uuid, ${manager.actor.userId}, 'ページ境界の試験', ${data}::jsonb, ${data}::jsonb, '2024-01-01T00:00:00.123456Z'::timestamptz)`;
    let cursor: string | null = null; const observed: string[] = [];
    do {
      const response = await api(`/api/admin/attendance/${record.id}?limit=1${cursor ? `&cursor=${cursor}` : ""}`, manager.cookie);
      const result = attendanceDetailResponseSchema.parse(await response.json());
      observed.push(...result.revisions.map((item) => item.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(observed).toEqual(ids.sort().reverse());
  });

  it("監査保存が失敗した訂正をロールバックする", async () => {
    const manager = await admin(), target = await person(), record = await visit(target.id);
    const failing = db.$extends({ query: { auditEvent: { async create() { throw new Error("試験用の監査保存失敗"); } } } }) as unknown as Database;
    const failingApp = createApp(failing, config);
    const response = await failingApp.request(`/api/admin/attendance/${record.id}`, { method: "PATCH", headers: { origin: config.origin, cookie: manager.cookie, "content-type": "application/json" }, body: JSON.stringify(fields(record)) });
    expect(response.status).toBe(503);
    expect((await db.attendanceVisit.findUniqueOrThrow({ where: { id: record.id } })).version).toBe(1);
    expect(await db.attendanceRevision.count({ where: { visitId: record.id } })).toBe(0);
  });
});

describe("検索と同じ条件のCSV", () => {
  it("UTF-8 BOM・引用符・改行・施設TZを保持し、数式を文字列として出力する", async () => {
    const manager = await admin(), target = await person('=HYPERLINK("https://example.invalid")', '所,"属\n確認', `+${randomUUID()}`);
    const record = await visit(target.id);
    const response = await api(`/api/admin/attendance.csv?personId=${target.id}`, manager.cookie);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8"); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="attendance.csv"');
    const bytes = new Uint8Array(await response.arrayBuffer()); expect(Array.from(bytes.slice(0, 3))).toEqual([239, 187, 191]);
    const text = new TextDecoder().decode(bytes);
    expect(text.includes('"\'=HYPERLINK(""https://example.invalid"")"')).toBe(true);
    expect(text.includes('"所,""属\n確認"')).toBe(true); expect(text.includes('"2024-01-01 09:00:00"')).toBe(true);
    expect(text.includes('"Asia/Tokyo"')).toBe(true); expect(text.includes(record.id)).toBe(true); expect(text.endsWith("\r\n")).toBe(true);
    const cells = readCsv(text);
    expect(cells.map((row) => row.length)).toEqual([12, 12]);
    expect(cells[1]!.slice(0, 4)).toEqual([target.id, `'${target.displayName}`, target.affiliation, `'${target.code}`]);
  });

  it("CSVの出力対象を履歴の検索と一致させ、取消を混ぜない", async () => {
    const manager = await admin(), target = await person();
    const included = await visit(target.id), excluded = await visit(target.id, "2024-01-02T00:00:00Z", null), canceled = await visit(target.id, "2024-01-03T00:00:00Z", null, new Date());
    const query = `personId=${target.id}&from=2024-01-01&to=2024-01-03&status=completed`;
    const result = await history(`/api/admin/attendance?${query}`, manager.cookie);
    const text = await csv(`/api/admin/attendance.csv?${query}`, manager.cookie);
    expect(result.items.map((row) => row.id)).toEqual([included.id]);
    expect(text.includes(included.id)).toBe(true); expect(text.includes(excluded.id)).toBe(false); expect(text.includes(canceled.id)).toBe(false);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "ATTENDANCE_CSV_EXPORTED", actorUserId: manager.actor.userId } });
    expect(audit.details).toEqual({ count: 1, filters: { personId: target.id, from: "2024-01-01", to: "2024-01-03", status: "completed", source: "all", corrected: "all", searchHash: null, affiliationHash: null } });
  });

  it("10000件の境界まで許可し、10001件は切り捨てず拒否する", async () => {
    const manager = await admin(), target = await person();
    const enteredAt = new Date("2020-01-01T00:00:00Z");
    await db.attendanceVisit.createMany({ data: Array.from({ length: 10_000 }, () => ({ personId: target.id, enteredAt, exitedAt: enteredAt })) });
    const first = await api(`/api/admin/attendance.csv?personId=${target.id}`, manager.cookie);
    expect(first.status).toBe(200); expect((await first.text()).split("\r\n").length).toBe(10_002);
    await visit(target.id, enteredAt.toISOString(), enteredAt.toISOString());
    const overflow = await api(`/api/admin/attendance.csv?personId=${target.id}`, manager.cookie);
    expect(overflow.status).toBe(422); expect((await overflow.json() as { code: string }).code).toBe("CSV_LIMIT_EXCEEDED");
  }, 30_000);

  it("CSVを連続出力すると試行制限し、Retry-Afterを返す", async () => {
    const manager = await admin();
    for (let index = 0; index < 10; index++) expect((await api(`/api/admin/attendance.csv?personId=${randomUUID()}`, manager.cookie)).status).toBe(200);
    const response = await api(`/api/admin/attendance.csv?personId=${randomUUID()}`, manager.cookie);
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("60");
  });
});
