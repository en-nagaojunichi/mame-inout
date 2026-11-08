import { afterAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createDatabase, type Database } from "../../apps/api/src/db.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createApp } from "../../apps/api/src/app.js";
import { hash, newToken } from "../../apps/api/src/setup.js";
import { issueAttendanceRequest, recordAttendance } from "../../apps/api/src/attendance.js";
import { createPerson, getPerson, issuePersonQr, listPeople, revokePersonQr, setPersonStatus, updatePerson } from "../../apps/api/src/people.js";

// 実際の名簿・パスキーを使わず、専用テストDBの架空データだけを操作する。
if (!/^mame-inout-test(?:-|$)/.test(process.env.TEST_PROJECT ?? "")) throw new Error("独立したテスト用Composeプロジェクトが必要です。");
const config = loadConfig();
const db = createDatabase(config);
const app = createApp(db, config);
const users: string[] = [];
const people: string[] = [];
const devices: string[] = [];

afterAll(async () => {
  await db.attendanceRequest.deleteMany({ where: { deviceId: { in: devices } } });
  await db.attendanceVisit.deleteMany({ where: { personId: { in: people } } });
  await db.person.deleteMany({ where: { id: { in: people } } });
  await db.receptionDevice.deleteMany({ where: { id: { in: devices } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

async function admin(recent = true, role = "ADMIN") {
  try {
    const user = await db.user.create({ data: { id: randomUUID(), name: "名簿確認の管理者", email: `${randomUUID()}@example.test`, role } });
    users.push(user.id);
    const token = newToken();
    const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, token,
      expiresAt: new Date(Date.now() + 600_000), authenticatedAt: recent ? new Date() : new Date(Date.now() - 360_000) } });
    const signature = createHmac("sha256", config.secret).update(token).digest("base64");
    return { actor: { userId: user.id, sessionId: session.id }, cookie: `${config.secure ? "__Secure-" : ""}better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` };
  } catch { throw new Error("名簿試験の管理者を準備できませんでした。"); }
}

async function person(actor: Awaited<ReturnType<typeof admin>>["actor"], displayName = "名簿確認の利用者", code?: string) {
  const result = await createPerson(db, actor, { displayName, ...(code ? { code } : {}) });
  people.push(result.id);
  return result;
}

async function reception() {
  const token = newToken();
  const device = await db.receptionDevice.create({ data: { name: "名簿試験の受付", status: "APPROVED", approvedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) } });
  devices.push(device.id);
  const credential = await db.receptionCredential.create({ data: { deviceId: device.id, tokenHash: hash(token), expiresAt: device.expiresAt! } });
  return { actor: { deviceId: device.id, credentialId: credential.id }, cookie: `${config.secure ? "__Secure-mame-reception" : "mame_reception"}=${token}` };
}

function api(path: string, cookie?: string, body?: unknown, method = body === undefined ? "GET" : "POST", origin = config.origin) {
  return app.request(path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function code(action: () => Promise<unknown>) {
  try { await action(); return null; } catch (cause) {
    return typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : "UNEXPECTED";
  }
}

async function scan(actor: Awaited<ReturnType<typeof reception>>["actor"], qr: string, mode: "IN" | "OUT" = "IN") {
  const request = await issueAttendanceRequest(db, actor);
  return recordAttendance(db, actor, { requestId: request.requestId, qr, mode });
}

function failingAudit() {
  return db.$extends({ query: { auditEvent: { async create() { throw new Error("監査保存失敗を試験します。"); } } } }) as unknown as Database;
}

describe("利用者の名簿とQR資格", () => {
  it("必須名のみで作成でき、任意項目はnull、同姓同名も別の利用者になる", async () => {
    const manager = await admin(false);
    const first = await person(manager.actor);
    const second = await person(manager.actor);
    expect(first.id !== second.id).toBe(true);
    expect({ name: first.displayName, phonetic: first.phoneticName, affiliation: first.affiliation, code: first.code, status: first.status, version: first.version, qrActive: first.qrActive })
      .toEqual({ name: "名簿確認の利用者", phonetic: null, affiliation: null, code: null, status: "ACTIVE", version: 1, qrActive: false });
    expect(Number.isFinite(Date.parse(first.createdAt))).toBe(true);
  });

  it("名前と任意項目をtrimし、空の任意項目を未指定として保存する", async () => {
    const manager = await admin();
    const first = await createPerson(db, manager.actor, { displayName: "  表示名  ", phoneticName: "  よみ  ", affiliation: "  ", code: " " }); people.push(first.id);
    expect([first.displayName, first.phoneticName, first.affiliation, first.code]).toEqual(["表示名", "よみ", null, null]);
  });

  it("100/64文字上限を受理し、空名・超過・追加個人情報・不正型を拒否する", async () => {
    const manager = await admin();
    const maximum = await createPerson(db, manager.actor, { displayName: "名".repeat(100), phoneticName: "あ".repeat(100), affiliation: "所".repeat(100), code: "C".repeat(64) }); people.push(maximum.id);
    for (const input of [{ displayName: " " }, { displayName: "名".repeat(101) }, { displayName: "確認", code: "C".repeat(65) },
      { displayName: "確認", phoneticName: "あ".repeat(101) }, { displayName: "確認", affiliation: "所".repeat(101) }, { displayName: "確認", email: "unused@example.test" }, { displayName: 10 }]) {
      expect((await api("/api/admin/people", manager.cookie, input)).status).toBe(422);
    }
    expect((await api("/api/admin/people", manager.cookie, { displayName: "確認", status: "ACTIVE" })).status).toBe(422);
  });

  it("施設内コードを一意にし、同時登録の片方だけを保存する", async () => {
    const managerA = await admin(), managerB = await admin();
    const input = { displayName: "コード競合の利用者", code: `code-${randomUUID()}` };
    const results = await Promise.all([managerA, managerB].map((manager) => createPerson(db, manager.actor, input)
      .then((result) => { people.push(result.id); return "OK"; }).catch((error: { code: string }) => error.code)));
    expect(results.sort()).toEqual(["OK", "PERSON_CODE_IN_USE"].sort());
    expect(await db.person.count({ where: { code: input.code } })).toBe(1);
  });

  it("管理者以外には一覧/詳細/登録/編集/状態/QR経路を許可しない", async () => {
    const manager = await admin(); const target = await person(manager.actor); const desk = await reception(); const other = await admin(true, "VIEWER");
    const routes = [
      { path: "/api/admin/people", method: "GET", body: undefined }, { path: `/api/admin/people/${target.id}`, method: "GET", body: undefined },
      { path: "/api/admin/people", method: "POST", body: { displayName: "未許可" } },
      { path: `/api/admin/people/${target.id}`, method: "PATCH", body: { displayName: "未許可", expectedVersion: 1 } },
      { path: `/api/admin/people/${target.id}/status`, method: "PUT", body: { status: "SUSPENDED", expectedVersion: 1 } },
      { path: `/api/admin/people/${target.id}/qr-credentials`, method: "POST", body: { expectedVersion: 1 } },
      { path: `/api/admin/people/${target.id}/qr-credentials/current`, method: "DELETE", body: { expectedVersion: 1 } },
    ];
    for (const route of routes) {
      expect((await api(route.path, undefined, route.body, route.method)).status).toBe(401);
      expect((await api(route.path, desk.cookie, route.body, route.method)).status).toBe(403);
      expect((await api(route.path, other.cookie, route.body, route.method)).status).toBe(403);
    }
    expect((await db.person.findUniqueOrThrow({ where: { id: target.id } })).version).toBe(1);
  });

  it("異なるOriginと不正ID/追加クエリ/不正状態/版を拒否する", async () => {
    const manager = await admin(); const target = await person(manager.actor);
    expect((await api("/api/admin/people", manager.cookie, { displayName: "不正Origin" }, "POST", "https://example.invalid")).status).toBe(403);
    expect((await api("/api/admin/people/not-an-id", manager.cookie)).status).toBe(422);
    expect((await api(`/api/admin/people/${randomUUID()}`, manager.cookie)).status).toBe(404);
    for (const query of ["limit=101", "status=UNKNOWN", "q=" + "x".repeat(101), "extra=1", "cursor=bad"]) expect((await api(`/api/admin/people?${query}`, manager.cookie)).status).toBe(422);
    expect((await api(`/api/admin/people/${target.id}`, manager.cookie, { displayName: "更新", expectedVersion: 0 }, "PATCH")).status).toBe(422);
    expect((await api(`/api/admin/people/${target.id}/status`, manager.cookie, { status: "DELETED", expectedVersion: 1 }, "PUT")).status).toBe(422);
  });

  it("名前/ふりがな/所属/コードを検索し状態とページ分割を保つ", async () => {
    const manager = await admin(); const prefix = `search-${randomUUID()}`;
    const first = await createPerson(db, manager.actor, { displayName: `${prefix}-氏名`, phoneticName: `${prefix}-よみ`, affiliation: `${prefix}-所属`, code: `${prefix}-code` }); people.push(first.id);
    const second = await person(manager.actor, `${prefix}-二人目`);
    await setPersonStatus(db, manager.actor, second.id, { expectedVersion: second.version, status: "SUSPENDED" });
    for (const suffix of ["氏名", "よみ", "所属", "code"]) {
      expect((await listPeople(db, { limit: 20, q: `${prefix}-${suffix}` })).items.map((item) => item.id)).toEqual([first.id]);
    }
    expect((await listPeople(db, { limit: 20, q: prefix, status: "SUSPENDED" })).items.map((item) => item.id)).toEqual([second.id]);
    const page1 = await listPeople(db, { limit: 1, q: prefix });
    const page2 = await listPeople(db, { limit: 1, q: prefix, cursor: page1.nextCursor! });
    expect(new Set([...page1.items, ...page2.items].map((item) => item.id)).size).toBe(2);
    expect(page2.nextCursor).toBeNull();
  });

  it("検索の%・_・バックスラッシュをワイルドカードとして展開しない", async () => {
    const manager = await admin(); const prefix = `literal-${randomUUID()}`;
    const first = await person(manager.actor, `${prefix}%_`);
    await person(manager.actor, `${prefix}ab`);
    expect((await listPeople(db, { limit: 20, q: `${prefix}%_` })).items.map((item) => item.id)).toEqual([first.id]);
    const slash = await person(manager.actor, `${prefix}\\x`);
    expect((await listPeople(db, { limit: 20, q: `${prefix}\\x` })).items.map((item) => item.id)).toEqual([slash.id]);
  });

  it("編集はプロフィールと版だけを変更し、古い画面の再保存を拒否する", async () => {
    const manager = await admin(false); const target = await person(manager.actor);
    const changed = await updatePerson(db, manager.actor, target.id, { displayName: "変更後の名前", affiliation: "試験所属", expectedVersion: 1 });
    expect([changed.displayName, changed.affiliation, changed.status, changed.version, changed.qrActive]).toEqual(["変更後の名前", "試験所属", "ACTIVE", 2, false]);
    expect(changed.createdAt).toBe(target.createdAt);
    expect(await code(() => updatePerson(db, manager.actor, target.id, { displayName: "古い変更", expectedVersion: 1 }))).toBe("VERSION_CONFLICT");
  });

  it("別管理者による同じ版の同時編集は一方だけが確定する", async () => {
    const managerA = await admin(), managerB = await admin(); const target = await person(managerA.actor);
    const result = await Promise.all([code(() => updatePerson(db, managerA.actor, target.id, { displayName: "変更A", expectedVersion: 1 })),
      code(() => updatePerson(db, managerB.actor, target.id, { displayName: "変更B", expectedVersion: 1 }))]);
    expect(result.filter((value) => value === null).length).toBe(1); expect(result.filter((value) => value === "VERSION_CONFLICT").length).toBe(1);
    expect((await getPerson(db, managerA.actor, target.id)).version).toBe(2);
  });

  it("重要操作は直近の本人確認を必要とし、通常編集では追加認証を求めない", async () => {
    const manager = await admin(false); const target = await person(manager.actor);
    expect((await api(`/api/admin/people/${target.id}`, manager.cookie, { displayName: "通常更新", expectedVersion: 1 }, "PATCH")).status).toBe(200);
    for (const [suffix, method, body] of [["status", "PUT", { status: "SUSPENDED", expectedVersion: 2 }], ["qr-credentials", "POST", { expectedVersion: 2 }], ["qr-credentials/current", "DELETE", { expectedVersion: 2 }]] as const) {
      const response = await api(`/api/admin/people/${target.id}/${suffix}`, manager.cookie, body, method);
      expect(response.status).toBe(403); expect((await response.json() as { code: string }).code).toBe("REAUTH_REQUIRED");
    }
  });

  it("QRは専用のランダム形式で一度発行し、DBと監査に生値を保存しない", async () => {
    const manager = await admin(); const target = await person(manager.actor);
    const issued = await issuePersonQr(db, manager.actor, target.id, { expectedVersion: 1 });
    const stored = await db.qrCredential.findFirstOrThrow({ where: { personId: target.id, revokedAt: null } });
    const audits = await db.auditEvent.findMany({ where: { personId: target.id } });
    expect(/^mio1_[A-Za-z0-9_-]{43}$/.test(issued.qr)).toBe(true);
    expect(stored.tokenHash === hash(issued.qr)).toBe(true);
    expect(JSON.stringify({ stored, audits }).includes(issued.qr)).toBe(false);
    expect(Object.keys(await getPerson(db, manager.actor, target.id)).sort()).toEqual(["id", "displayName", "phoneticName", "affiliation", "code", "status", "version", "createdAt", "updatedAt", "qrActive"].sort());
    expect(issued.version).toBe(2); expect((await getPerson(db, manager.actor, target.id)).qrActive).toBe(true);
    expect((await api(`/api/admin/people/${target.id}`, manager.cookie)).headers.get("Cache-Control")).toBe("no-store");
  });

  it("再発行は旧QRだけを失効し、在室と過去記録を保持する", async () => {
    const manager = await admin(); const target = await person(manager.actor); const desk = await reception();
    const first = await issuePersonQr(db, manager.actor, target.id, { expectedVersion: 1 });
    expect((await scan(desk.actor, first.qr)).body.outcome).toBe("RECORDED");
    const before = await db.attendanceVisit.findMany({ where: { personId: target.id } });
    const second = await issuePersonQr(db, manager.actor, target.id, { expectedVersion: 2 });
    expect(first.qr !== second.qr).toBe(true);
    expect((await scan(desk.actor, first.qr, "OUT")).body.outcome).toBe("QR_INVALID");
    expect(JSON.stringify(await db.attendanceVisit.findMany({ where: { personId: target.id } })) === JSON.stringify(before)).toBe(true);
    expect((await scan(desk.actor, second.qr, "OUT")).body.outcome).toBe("RECORDED");
  });

  it("同時再発行と応答消失後の古い版での再送はQRを重複発行しない", async () => {
    const managerA = await admin(), managerB = await admin(); const target = await person(managerA.actor);
    const result = await Promise.all([code(() => issuePersonQr(db, managerA.actor, target.id, { expectedVersion: 1 })),
      code(() => issuePersonQr(db, managerB.actor, target.id, { expectedVersion: 1 }))]);
    expect(result.filter((value) => value === null).length).toBe(1); expect(result.filter((value) => value === "VERSION_CONFLICT").length).toBe(1);
    expect(await code(() => issuePersonQr(db, managerA.actor, target.id, { expectedVersion: 1 }))).toBe("VERSION_CONFLICT");
    expect(await db.qrCredential.count({ where: { personId: target.id } })).toBe(1);
  });

  it("停止はQRを失効し、再開しても古いQRを復活させない", async () => {
    const manager = await admin(); const target = await person(manager.actor); const desk = await reception();
    const issued = await issuePersonQr(db, manager.actor, target.id, { expectedVersion: 1 });
    const stopped = await setPersonStatus(db, manager.actor, target.id, { expectedVersion: 2, status: "SUSPENDED" });
    expect([stopped.status, stopped.version, stopped.qrActive]).toEqual(["SUSPENDED", 3, false]);
    expect(await code(() => issuePersonQr(db, manager.actor, target.id, { expectedVersion: 3 }))).toBe("PERSON_UNAVAILABLE");
    const resumed = await setPersonStatus(db, manager.actor, target.id, { expectedVersion: 3, status: "ACTIVE" });
    expect([resumed.status, resumed.version, resumed.qrActive]).toEqual(["ACTIVE", 4, false]);
    expect((await scan(desk.actor, issued.qr)).body.outcome).toBe("QR_INVALID");
    expect((await issuePersonQr(db, manager.actor, target.id, { expectedVersion: 4 })).version).toBe(5);
  });

  it("在室中の停止は拒否し、同時入室と停止でも不正な在室を作らない", async () => {
    const manager = await admin(); const target = await person(manager.actor); const desk = await reception();
    const issued = await issuePersonQr(db, manager.actor, target.id, { expectedVersion: 1 });
    await scan(desk.actor, issued.qr);
    expect(await code(() => setPersonStatus(db, manager.actor, target.id, { expectedVersion: 2, status: "SUSPENDED" }))).toBe("PERSON_INSIDE");
    const other = await person(manager.actor); const qr = await issuePersonQr(db, manager.actor, other.id, { expectedVersion: 1 });
    const results = await Promise.all([scan(desk.actor, qr.qr), code(() => setPersonStatus(db, manager.actor, other.id, { expectedVersion: 2, status: "SUSPENDED" }))]);
    const latest = await getPerson(db, manager.actor, other.id);
    const opened = await db.attendanceVisit.count({ where: { personId: other.id, exitedAt: null, canceledAt: null } });
    expect(latest.status === "SUSPENDED" ? opened === 0 : opened === 1).toBe(true);
    expect(results[1] === null || results[1] === "PERSON_INSIDE").toBe(true);
  });

  it("QR失効は在室を変更せず、同じ版の繰返し失効は既存資格を戻さない", async () => {
    const manager = await admin(); const target = await person(manager.actor); const desk = await reception();
    const issued = await issuePersonQr(db, manager.actor, target.id, { expectedVersion: 1 });
    await scan(desk.actor, issued.qr);
    const result = await revokePersonQr(db, manager.actor, target.id, { expectedVersion: 2 });
    expect([result.version, result.qrActive]).toEqual([3, false]);
    expect((await revokePersonQr(db, manager.actor, target.id, { expectedVersion: 3 })).version).toBe(3);
    expect(await db.attendanceVisit.count({ where: { personId: target.id, exitedAt: null, canceledAt: null } })).toBe(1);
    expect((await scan(desk.actor, issued.qr, "OUT")).body.outcome).toBe("QR_INVALID");
  });

  it("削除済み利用者を編集・再開・再発行で復活させない", async () => {
    const manager = await admin(); const target = await person(manager.actor);
    await db.person.update({ where: { id: target.id }, data: { status: "DELETED" } });
    expect(await code(() => updatePerson(db, manager.actor, target.id, { displayName: "復活", expectedVersion: 1 }))).toBe("PERSON_UNAVAILABLE");
    expect(await code(() => setPersonStatus(db, manager.actor, target.id, { status: "ACTIVE", expectedVersion: 1 }))).toBe("PERSON_UNAVAILABLE");
    expect(await code(() => issuePersonQr(db, manager.actor, target.id, { expectedVersion: 1 }))).toBe("PERSON_UNAVAILABLE");
  });

  it("監査保存の失敗時は登録・更新・状態・QRの変更を原子的に戻す", async () => {
    const manager = await admin(); const target = await person(manager.actor); const broken = failingAudit();
    const count = await db.person.count();
    expect(await code(() => createPerson(broken, manager.actor, { displayName: "保存されない利用者" }))).toBe("UNEXPECTED"); expect(await db.person.count()).toBe(count);
    expect(await code(() => updatePerson(broken, manager.actor, target.id, { displayName: "保存されない名前", expectedVersion: 1 }))).toBe("UNEXPECTED");
    expect(await code(() => setPersonStatus(broken, manager.actor, target.id, { status: "SUSPENDED", expectedVersion: 1 }))).toBe("UNEXPECTED");
    expect(await code(() => issuePersonQr(broken, manager.actor, target.id, { expectedVersion: 1 }))).toBe("UNEXPECTED");
    expect(await db.qrCredential.count({ where: { personId: target.id } })).toBe(0);
    const issued = await issuePersonQr(db, manager.actor, target.id, { expectedVersion: 1 });
    expect(await code(() => revokePersonQr(broken, manager.actor, target.id, { expectedVersion: 2 }))).toBe("UNEXPECTED");
    expect((await getPerson(db, manager.actor, target.id)).version).toBe(2);
    expect(await db.qrCredential.count({ where: { personId: target.id, tokenHash: hash(issued.qr), revokedAt: null } })).toBe(1);
  });

  it("Personの更新版は実DBでも0以下にできない", async () => {
    const manager = await admin(); const target = await person(manager.actor);
    expect(await code(() => db.person.update({ where: { id: target.id }, data: { version: 0 } }))).not.toBeNull();
    expect((await getPerson(db, manager.actor, target.id)).version).toBe(1);
  });

  it.each(["session", "recent"] as const)("利用者行の実ロック待機後に%s期限が切れた変更を確定しない", async (kind) => {
    const manager = await admin(); const target = await person(manager.actor);
    let unlock!: () => void; let acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${target.id}::uuid FOR UPDATE`;
      acquired(); await release;
    }, { timeout: 15_000 });
    await locked;
    const changing = code(() => kind === "recent" ? issuePersonQr(db, manager.actor, target.id, { expectedVersion: 1 })
      : updatePerson(db, manager.actor, target.id, { displayName: "期限切れで保存しない名前", expectedVersion: 1 }));
    let observedWait = false;
    try {
      // 固定時間の待機だけで競合成立と見なさず、実際の別接続のロック待ちを観測する。
      for (let i = 0; i < 50; i++) {
        const rows = await db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = current_user
            AND wait_event_type = 'Lock' AND query LIKE '%Person%' AND query LIKE '%FOR UPDATE%') AS waiting`;
        if (rows[0]?.waiting) { observedWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedWait).toBe(true);
      await db.session.update({ where: { id: manager.actor.sessionId }, data: kind === "recent"
        ? { authenticatedAt: new Date(Date.now() - 360_000) } : { expiresAt: new Date(Date.now() - 60_000) } });
    } finally { unlock(); await blocker; }
    expect(await changing).toBe(kind === "recent" ? "REAUTH_REQUIRED" : "UNAUTHENTICATED");
    const unchanged = await db.person.findUniqueOrThrow({ where: { id: target.id } });
    expect([unchanged.displayName, unchanged.version]).toEqual([target.displayName, 1]);
    expect(await db.qrCredential.count({ where: { personId: target.id } })).toBe(0);
  });

  it("管理者行のロック待機中に停止された場合は利用者を変更しない", async () => {
    const manager = await admin(); const target = await person(manager.actor);
    let unlock!: () => void; let acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${manager.actor.userId} FOR UPDATE`;
      acquired(); await release;
      await tx.user.update({ where: { id: manager.actor.userId }, data: { status: "DISABLED" } });
    }, { timeout: 15_000 });
    await locked;
    const changing = code(() => updatePerson(db, manager.actor, target.id, { displayName: "停止後に保存しない名前", expectedVersion: 1 }));
    let observedWait = false;
    try {
      for (let i = 0; i < 50; i++) {
        const rows = await db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = current_user
            AND wait_event_type = 'Lock' AND query LIKE '%User%' AND query LIKE '%FOR UPDATE%') AS waiting`;
        if (rows[0]?.waiting) { observedWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedWait).toBe(true);
    } finally { unlock(); await blocker; }
    expect(await changing).toBe("UNAUTHENTICATED");
    const unchanged = await db.person.findUniqueOrThrow({ where: { id: target.id } });
    expect([unchanged.displayName, unchanged.version]).toEqual([target.displayName, 1]);
  });
});
