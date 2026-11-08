import { afterAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createDatabase, type Database } from "../../apps/api/src/db.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createApp } from "../../apps/api/src/app.js";
import { hash, newToken } from "../../apps/api/src/setup.js";
import {
  authenticateReception, cleanupAttendanceRequests, correctAttendanceVisit, createManualVisit,
  getAttendanceRequest, issueAttendanceRequest, recordAttendance, suspendPerson,
} from "../../apps/api/src/attendance.js";
import { facilityDateTime } from "../../apps/api/src/attendance-rules.js";

// 実際の認証・業務データを使わず、隔離したテストプロジェクトだけで検証する。
if (!/^mame-inout-test(?:-|$)/.test(process.env.TEST_PROJECT ?? "")) throw new Error("独立したテスト用Composeプロジェクトが必要です。");
const config = loadConfig();
const db = createDatabase(config);
const app = createApp(db, config);
const createdUserIds: string[] = [];
afterAll(async () => {
  // 後続の初期管理者E2Eへ認証用fixtureを持ち越さない。業務監査はSET NULLで保持する。
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await db.$disconnect();
});

async function now() {
  return (await db.$queryRaw<{ value: Date }[]>`SELECT clock_timestamp() AS value`)[0]!.value;
}

async function fixture() {
  const time = await now();
  const person = await db.person.create({ data: { displayName: "受付確認の利用者" } });
  const qr = `mio1_${newToken()}`;
  await db.qrCredential.create({ data: { personId: person.id, tokenHash: hash(qr) } });
  return { person, qr, time };
}

async function device() {
  const time = await now();
  const token = newToken();
  const device = await db.receptionDevice.create({ data: {
    name: "動作確認の受付", status: "APPROVED", approvedAt: time,
    expiresAt: new Date(time.getTime() + 86_400_000),
  } });
  const credential = await db.receptionCredential.create({ data: {
    deviceId: device.id, tokenHash: hash(token), expiresAt: new Date(time.getTime() + 86_400_000),
  } });
  return { actor: { deviceId: device.id, credentialId: credential.id }, token,
    cookie: `${config.secure ? "__Secure-mame-reception" : "mame_reception"}=${token}` };
}

async function administrator(role = "ADMIN") {
  try {
    const user = await db.user.create({ data: { id: randomUUID(), name: "権限確認の管理者", email: `${randomUUID()}@example.test`, role } });
    createdUserIds.push(user.id);
    const token = newToken();
    const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, token, expiresAt: new Date(Date.now() + 600_000), authenticatedAt: new Date() } });
    const signature = createHmac("sha256", config.secret).update(token).digest("base64");
    return { actor: { userId: user.id, sessionId: session.id }, cookie: `${config.secure ? "__Secure-" : ""}better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` };
  } catch {
    // 作成失敗時も、ライブラリ例外に含まれ得るテスト用セッション値を出力しない。
    throw new Error("検証用の管理者とセッションを準備できませんでした。");
  }
}

async function attempt(actor: { deviceId: string; credentialId: string }, qr: string, mode: "IN" | "OUT" = "IN") {
  const ticket = await issueAttendanceRequest(db, actor);
  const input = { requestId: ticket.requestId, mode, qr };
  return { ticket, input, result: await recordAttendance(db, actor, input) };
}

function api(path: string, cookie?: string, body?: unknown, instance = app) {
  return instance.request(path, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { origin: config.origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
  });
}

async function errorResult(action: () => Promise<unknown>) {
  try { await action(); return null; } catch (error) {
    // SQL・資格情報・入力全体を失敗差分へ含めず、固定の機械判定用コードだけを比較する。
    const value = error as { code?: unknown; status?: unknown };
    return { code: typeof value.code === "string" ? value.code : null, status: typeof value.status === "number" ? value.status : null };
  }
}

async function rejected(action: () => Promise<unknown>) {
  try { await action(); return false; } catch { return true; }
}

describe("受付の認証・役割・公開範囲", () => {
  it("全実装経路で未認証と役割違反を拒否し、経路ごとの資格を使う", async () => {
    const reception = await device();
    const admin = await administrator();
    const person = await fixture();
    const ticket = await issueAttendanceRequest(db, reception.actor);
    const adminPaths = ["/api/admin/me", "/api/admin/facility", "/api/admin/people", "/api/admin/presence", "/api/admin/attendance"];
    const receptionPaths = [
      { path: "/api/reception/requests", body: {} },
      { path: "/api/reception/records", body: { requestId: ticket.requestId, mode: "IN", qr: person.qr } },
      { path: `/api/reception/requests/${ticket.requestId}`, body: undefined },
    ];
    for (const path of adminPaths) {
      expect((await api(path)).status).toBe(401);
      expect((await api(path, reception.cookie)).status).toBe(403);
      const allowed = await api(path, admin.cookie);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toBe("no-store");
    }
    for (const { path, body } of receptionPaths) {
      expect((await api(path, undefined, body)).status).toBe(401);
      expect((await api(path, admin.cookie, body)).status).toBe(403);
      expect((await api(path, reception.cookie, body)).status).toBe(path === "/api/reception/requests" ? 201 : 200);
    }
    const both = `${admin.cookie}; ${reception.cookie}`;
    expect((await api("/api/admin/me", both)).status).toBe(200);
    expect((await api("/api/reception/requests", both, {})).status).toBe(201);
    const falseAdmin = await administrator("RECEPTION");
    expect((await api("/api/admin/people", falseAdmin.cookie)).status).toBe(403);
  });

  it("未承認・端末失効・資格失効・両方の期限切れを毎回拒否する", async () => {
    for (const state of ["PENDING", "REVOKED", "DEVICE_EXPIRED", "CREDENTIAL_REVOKED", "CREDENTIAL_EXPIRED"] as const) {
      const reception = await device();
      expect(Boolean(await authenticateReception(db, reception.token))).toBe(true);
      const time = await now();
      if (state === "PENDING" || state === "REVOKED") await db.receptionDevice.update({ where: { id: reception.actor.deviceId }, data: { status: state } });
      if (state === "DEVICE_EXPIRED") await db.receptionDevice.update({ where: { id: reception.actor.deviceId }, data: { expiresAt: new Date(time.getTime() - 1_000) } });
      if (state === "CREDENTIAL_REVOKED") await db.receptionCredential.update({ where: { id: reception.actor.credentialId }, data: { revokedAt: time } });
      if (state === "CREDENTIAL_EXPIRED") await db.receptionCredential.update({ where: { id: reception.actor.credentialId }, data: { expiresAt: new Date(time.getTime() - 1_000) } });
      expect(Boolean(await authenticateReception(db, reception.token))).toBe(false);
      expect((await api("/api/reception/requests", reception.cookie, {})).status).toBe(401);
      expect((await errorResult(() => issueAttendanceRequest(db, reception.actor)))?.status).toBe(401);
    }
    expect(Boolean(await authenticateReception(db, newToken()))).toBe(false);
  });

  it("結果は自端末に限定し、受付DTOにQR・資格・名簿内部情報を返さない", async () => {
    const reception = await device();
    const other = await device();
    const person = await fixture();
    const request = await attempt(reception.actor, person.qr);
    const foreign = await api(`/api/reception/requests/${request.ticket.requestId}`, other.cookie);
    expect(foreign.status).toBe(404);
    expect((await errorResult(() => recordAttendance(db, other.actor, request.input)))?.status).toBe(404);
    const own = await api(`/api/reception/requests/${request.ticket.requestId}`, reception.cookie);
    expect(own.status).toBe(200);
    const value = JSON.stringify(await own.json());
    expect([person.qr, reception.token, other.token, person.person.id, reception.actor.credentialId, "tokenHash", "payloadHash"].every((secret) => !value.includes(secret))).toBe(true);
    expect(own.headers.get("cache-control")).toBe("no-store");
  });

  it("余計なクライアント時刻・不正QR形式・不正Origin・一覧上限を拒否する", async () => {
    const reception = await device();
    const person = await fixture();
    const ticket = await issueAttendanceRequest(db, reception.actor);
    const input = { requestId: ticket.requestId, mode: "IN", qr: person.qr };
    expect((await api("/api/reception/records", reception.cookie, { ...input, occurredAt: new Date(0).toISOString() })).status).toBe(422);
    expect((await api("/api/reception/records", reception.cookie, { ...input, qr: "https://invalid.example/" })).status).toBe(422);
    expect((await api("/api/reception/requests", reception.cookie, { requestId: randomUUID() })).status).toBe(422);
    const foreign = await app.request("/api/reception/records", { method: "POST", headers: { cookie: reception.cookie, origin: "https://foreign.example", "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(foreign.status).toBe(403);
    const admin = await administrator();
    for (const path of ["people", "presence", "attendance"]) expect((await api(`/api/admin/${path}?limit=101`, admin.cookie)).status).toBe(422);
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id } })).toBe(0);
  });

  it("再送と照会も端末単位の同じ試行上限へ数え、API再作成でリセットしない", async () => {
    const reception = await device();
    const ticket = await issueAttendanceRequest(db, reception.actor);
    const input = { requestId: ticket.requestId, mode: "IN", qr: `mio1_${newToken()}` };
    const restarted = createApp(db, config);
    for (let index = 0; index < 120; index++) {
      const instance = index < 60 ? app : restarted;
      const response = index % 2 === 0
        ? await api("/api/reception/records", reception.cookie, input, instance)
        : await api(`/api/reception/requests/${ticket.requestId}`, reception.cookie, undefined, instance);
      expect(response.status).toBe(index % 2 === 0 ? 409 : 200);
    }
    const limited = await api("/api/reception/requests", reception.cookie, {}, restarted);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});

describe("要求ID・再送・結果保持", () => {
  it("初回5分・結果24時間のサーバー発行要求だけを受理する", async () => {
    const reception = await device();
    const person = await fixture();
    const ticket = await issueAttendanceRequest(db, reception.actor);
    const row = await db.attendanceRequest.findUniqueOrThrow({ where: { id: ticket.requestId } });
    expect(row.acceptUntil.getTime() - row.issuedAt.getTime()).toBe(300_000);
    expect(row.resultUntil.getTime() - row.issuedAt.getTime()).toBe(86_400_000);
    const unknown = { requestId: randomUUID(), mode: "IN" as const, qr: person.qr };
    expect(await errorResult(() => recordAttendance(db, reception.actor, unknown))).toEqual({ code: "REQUEST_EXPIRED", status: 410 });
    expect((await errorResult(() => getAttendanceRequest(db, reception.actor, unknown.requestId)))?.status).toBe(410);
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id } })).toBe(0);
  });

  it("同じIDの同じ内容は初回結果を返し、異なる内容を拒否する", async () => {
    const reception = await device();
    const person = await fixture();
    const first = await attempt(reception.actor, person.qr);
    const replay = await recordAttendance(db, reception.actor, first.input);
    expect(replay).toEqual(first.result);
    expect(await errorResult(() => recordAttendance(db, reception.actor, { ...first.input, mode: "OUT" }))).toEqual({ code: "REQUEST_CONFLICT", status: 409 });
    expect(await errorResult(() => recordAttendance(db, reception.actor, { ...first.input, qr: `mio1_${newToken()}` }))).toEqual({ code: "REQUEST_CONFLICT", status: 409 });
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { requestId: first.ticket.requestId } })).toBe(1);
    const result = await getAttendanceRequest(db, reception.actor, first.ticket.requestId);
    expect(result).toEqual({ state: "completed", result: first.result.body });
  });

  it("未完了は初回期限後に拒否するが、確定済みは結果期限まで再利用できる", async () => {
    const reception = await device();
    const person = await fixture();
    const pending = await issueAttendanceRequest(db, reception.actor);
    expect((await getAttendanceRequest(db, reception.actor, pending.requestId)).state).toBe("pending");
    const time = await now();
    const expiredAcceptance = { issuedAt: new Date(time.getTime() - 600_000), acceptUntil: new Date(time.getTime() - 300_000), resultUntil: new Date(time.getTime() + 86_000_000) };
    await db.attendanceRequest.update({ where: { id: pending.requestId }, data: expiredAcceptance });
    expect((await errorResult(() => recordAttendance(db, reception.actor, { requestId: pending.requestId, mode: "IN", qr: person.qr })))?.status).toBe(410);
    const completed = await attempt(reception.actor, person.qr);
    await db.attendanceRequest.update({ where: { id: completed.ticket.requestId }, data: expiredAcceptance });
    expect(await recordAttendance(db, reception.actor, completed.input)).toEqual(completed.result);
    expect((await getAttendanceRequest(db, reception.actor, completed.ticket.requestId)).state).toBe("completed");
  });

  it("結果期限後は照会・再送を拒否し、保持削除後も新しい打刻として再受理しない", async () => {
    const reception = await device();
    const person = await fixture();
    const completed = await attempt(reception.actor, person.qr);
    const time = await now();
    await db.attendanceRequest.update({ where: { id: completed.ticket.requestId }, data: {
      issuedAt: new Date(time.getTime() - 26 * 3_600_000), acceptUntil: new Date(time.getTime() - 26 * 3_600_000 + 300_000), resultUntil: new Date(time.getTime() - 2 * 3_600_000),
    } });
    expect((await errorResult(() => getAttendanceRequest(db, reception.actor, completed.ticket.requestId)))?.status).toBe(410);
    expect((await errorResult(() => recordAttendance(db, reception.actor, completed.input)))?.status).toBe(410);
    expect(await cleanupAttendanceRequests(db)).toBeGreaterThanOrEqual(1);
    expect(await db.attendanceRequest.count({ where: { id: completed.ticket.requestId } })).toBe(0);
    expect((await errorResult(() => recordAttendance(db, reception.actor, completed.input)))?.status).toBe(410);
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id } })).toBe(1);
  });
});

describe("入退出の状態・同時操作・時刻", () => {
  it("入室と退室を明示的に扱い、業務上の拒否も初回結果として保存する", async () => {
    const reception = await device();
    const person = await fixture();
    const requests = [];
    const before = await now();
    for (const [mode, outcome] of [["OUT", "NOT_INSIDE"], ["IN", "RECORDED"], ["IN", "ALREADY_INSIDE"], ["OUT", "RECORDED"], ["OUT", "NOT_INSIDE"]] as const) {
      const operation = await attempt(reception.actor, person.qr, mode);
      requests.push(operation.ticket.requestId);
      expect(operation.result.body.outcome).toBe(outcome);
      expect(operation.result.status).toBe(outcome === "RECORDED" ? 200 : 409);
      expect(operation.result.body.timeZone).toBe("Asia/Tokyo");
      if (outcome === "RECORDED") expect(new Date(operation.result.body.recordedAt!).getTime()).toBeGreaterThanOrEqual(before.getTime());
      else expect(operation.result.body.recordedAt).toBeNull();
      expect(await recordAttendance(db, reception.actor, operation.input)).toEqual(operation.result);
    }
    const visits = await db.attendanceVisit.findMany({ where: { personId: person.person.id } });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.exitedAt!.getTime()).toBeGreaterThanOrEqual(visits[0]!.enteredAt.getTime());
    expect(await db.auditEvent.count({ where: { requestId: { in: requests } } })).toBe(5);
    const persisted = JSON.stringify(await db.attendanceRequest.findMany({ where: { id: { in: requests } } }));
    expect([person.qr, reception.token].every((secret) => !persisted.includes(secret))).toBe(true);
  });

  it("不明QR・停止・削除済み利用者は拒否し、対象者の表示名を返さない", async () => {
    const reception = await device();
    const unknown = await attempt(reception.actor, `mio1_${newToken()}`);
    expect(unknown.result.body.outcome).toBe("QR_INVALID");
    expect(unknown.result.body.person).toBeNull();
    for (const status of ["SUSPENDED", "DELETED"]) {
      const person = await fixture();
      await db.person.update({ where: { id: person.person.id }, data: { status } });
      const operation = await attempt(reception.actor, person.qr);
      expect(operation.result.body.outcome).toBe("PERSON_UNAVAILABLE");
      expect(operation.result.body.person).toBeNull();
      expect(await db.attendanceVisit.count({ where: { personId: person.person.id } })).toBe(0);
    }
  });

  it("同じIDを並列再送しても記録と監査は一度だけ確定する", async () => {
    const reception = await device();
    const person = await fixture();
    const ticket = await issueAttendanceRequest(db, reception.actor);
    const input = { requestId: ticket.requestId, mode: "IN" as const, qr: person.qr };
    const results = await Promise.all(Array.from({ length: 6 }, () => recordAttendance(db, reception.actor, input)));
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { requestId: ticket.requestId } })).toBe(1);
  });

  it("別端末の同時入室は一件だけ成功し、同時入退室も同じ排他順で決まる", async () => {
    const [first, second] = await Promise.all([device(), device()]);
    const person = await fixture();
    const tickets = await Promise.all([issueAttendanceRequest(db, first.actor), issueAttendanceRequest(db, second.actor)]);
    const results = await Promise.all([first, second].map((reception, index) => recordAttendance(db, reception.actor, { requestId: tickets[index]!.requestId, mode: "IN", qr: person.qr })));
    expect(results.map((result) => result.body.outcome).sort()).toEqual(["ALREADY_INSIDE", "RECORDED"]);
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id, exitedAt: null, canceledAt: null } })).toBe(1);

    const other = await fixture();
    const [enterTicket, exitTicket] = await Promise.all([issueAttendanceRequest(db, first.actor), issueAttendanceRequest(db, second.actor)]);
    const [enter, exit] = await Promise.all([
      recordAttendance(db, first.actor, { requestId: enterTicket.requestId, mode: "IN", qr: other.qr }),
      recordAttendance(db, second.actor, { requestId: exitTicket.requestId, mode: "OUT", qr: other.qr }),
    ]);
    expect(enter.body.outcome).toBe("RECORDED");
    expect(["RECORDED", "NOT_INSIDE"].includes(exit.body.outcome)).toBe(true);
    expect(await db.attendanceVisit.count({ where: { personId: other.person.id } })).toBe(1);
    expect(await db.attendanceVisit.count({ where: { personId: other.person.id, exitedAt: null, canceledAt: null } })).toBe(exit.body.outcome === "RECORDED" ? 0 : 1);
  });

  it("日跨ぎや長時間在室では自動退室せず、UTC保存と施設日付を区別する", async () => {
    const admin = await administrator();
    const reception = await device();
    const person = await fixture();
    const enteredAt = "2020-01-01T00:30:00+09:00";
    const visit = await createManualVisit(db, admin.actor, { personId: person.person.id, enteredAt, exitedAt: null, reason: "日跨ぎの確認" });
    const stored = await db.attendanceVisit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(stored.enteredAt.toISOString()).toBe("2019-12-31T15:30:00.000Z");
    expect(facilityDateTime(stored.enteredAt, "Asia/Tokyo")).toBe("2020-01-01 00:30:00");
    const rejectedEntry = await attempt(reception.actor, person.qr);
    expect(rejectedEntry.result.body.outcome).toBe("ALREADY_INSIDE");
    expect((await db.attendanceVisit.findUniqueOrThrow({ where: { id: visit.id } })).exitedAt).toBeNull();
    expect((await attempt(reception.actor, person.qr, "OUT")).result.body.outcome).toBe("RECORDED");
    await attempt(reception.actor, person.qr);
    let cursor: string | null = null;
    let observedCurrentEntry = false;
    do {
      const response = await api(`/api/admin/presence?limit=100${cursor ? `&cursor=${cursor}` : ""}`, admin.cookie);
      expect(response.status).toBe(200);
      const value = await response.json() as { asOf: string; items: Array<{ person: { id: string }; enteredAt: string }>; nextCursor: string | null };
      // 最新の入室も含め、表示対象の記録より前の時刻を一覧の取得時刻として返さない。
      expect(value.items.every((item) => Date.parse(item.enteredAt) <= Date.parse(value.asOf))).toBe(true);
      observedCurrentEntry = value.items.some((item) => item.person.id === person.person.id);
      cursor = value.nextCursor;
    } while (!observedCurrentEntry && cursor);
    expect(observedCurrentEntry).toBe(true);
  });
});

describe("手動記録・訂正・利用停止の共通排他", () => {
  it("未来・逆転・重複・空の理由を拒否し、接する区間は許可する", async () => {
    const admin = await administrator();
    const person = await fixture();
    const time = (await now()).getTime();
    const first = { personId: person.person.id, enteredAt: new Date(time - 4 * 3_600_000).toISOString(), exitedAt: new Date(time - 3 * 3_600_000).toISOString(), reason: "過去記録の確認" };
    await createManualVisit(db, admin.actor, first);
    expect((await errorResult(() => createManualVisit(db, admin.actor, { ...first, enteredAt: new Date(time + 86_400_000).toISOString(), exitedAt: null })))?.code).toBe("INVALID_TIME");
    expect((await errorResult(() => createManualVisit(db, admin.actor, { ...first, exitedAt: new Date(time - 5 * 3_600_000).toISOString() })))?.code).toBe("INVALID_TIME");
    expect((await errorResult(() => createManualVisit(db, admin.actor, first)))?.code).toBe("VISIT_OVERLAP");
    expect((await errorResult(() => createManualVisit(db, admin.actor, { ...first, reason: " " })))?.status).toBe(422);
    await createManualVisit(db, admin.actor, { ...first, enteredAt: first.exitedAt, exitedAt: new Date(time - 2 * 3_600_000).toISOString() });
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id } })).toBe(2);
  });

  it("訂正の古い版と重複を拒否し、変更前後・理由・実行者を残す", async () => {
    const admin = await administrator();
    const person = await fixture();
    const time = (await now()).getTime();
    const first = await createManualVisit(db, admin.actor, { personId: person.person.id, enteredAt: new Date(time - 4 * 3_600_000).toISOString(), exitedAt: new Date(time - 3 * 3_600_000).toISOString(), reason: "記録追加" });
    await createManualVisit(db, admin.actor, { personId: person.person.id, enteredAt: new Date(time - 2 * 3_600_000).toISOString(), exitedAt: new Date(time - 3_600_000).toISOString(), reason: "別区間の追加" });
    const input = { visitId: first.id, expectedVersion: first.version, enteredAt: first.enteredAt, exitedAt: first.exitedAt, cancel: false, reason: "入室時刻の補正" };
    expect((await errorResult(() => correctAttendanceVisit(db, admin.actor, { ...input, exitedAt: new Date(time - 90 * 60_000).toISOString() })))?.code).toBe("VISIT_OVERLAP");
    const countBefore = await db.attendanceRevision.count({ where: { visitId: first.id } });
    const changed = await correctAttendanceVisit(db, admin.actor, { ...input, enteredAt: new Date(time - 4 * 3_600_000 - 60_000).toISOString() });
    expect(changed.version).toBe(first.version + 1);
    expect((await errorResult(() => correctAttendanceVisit(db, admin.actor, input)))?.code).toBe("VERSION_CONFLICT");
    expect(await db.attendanceRevision.count({ where: { visitId: first.id } })).toBe(countBefore + 1);
    const revision = await db.attendanceRevision.findFirstOrThrow({ where: { visitId: first.id, reason: input.reason } });
    expect(revision.actorUserId).toBe(admin.actor.userId);
    expect(JSON.stringify(revision.before) !== JSON.stringify(revision.after)).toBe(true);
  });

  it("同じ版の並列訂正と通常退室対訂正で、古い状態を上書きしない", async () => {
    const admin = await administrator();
    const person = await fixture();
    const time = (await now()).getTime();
    const visit = await createManualVisit(db, admin.actor, { personId: person.person.id, enteredAt: new Date(time - 3_600_000).toISOString(), exitedAt: new Date(time - 1_800_000).toISOString(), reason: "並列訂正の準備" });
    const correction = { visitId: visit.id, expectedVersion: visit.version, enteredAt: visit.enteredAt, exitedAt: visit.exitedAt, cancel: false, reason: "並列訂正" };
    const results = await Promise.allSettled([1, 2].map((minutes) => correctAttendanceVisit(db, admin.actor, { ...correction, enteredAt: new Date(time - 3_600_000 - minutes * 60_000).toISOString() })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "VERSION_CONFLICT")).toHaveLength(1);
    expect((await db.attendanceVisit.findUniqueOrThrow({ where: { id: visit.id } })).version).toBe(visit.version + 1);

    const reception = await device();
    const other = await fixture();
    await attempt(reception.actor, other.qr);
    const open = await db.attendanceVisit.findFirstOrThrow({ where: { personId: other.person.id, exitedAt: null } });
    const exitTicket = await issueAttendanceRequest(db, reception.actor);
    const exitTime = await now();
    const concurrent = await Promise.allSettled([
      recordAttendance(db, reception.actor, { requestId: exitTicket.requestId, mode: "OUT", qr: other.qr }),
      correctAttendanceVisit(db, admin.actor, { visitId: open.id, expectedVersion: open.version, enteredAt: open.enteredAt.toISOString(), exitedAt: exitTime.toISOString(), cancel: false, reason: "退室補正" }),
    ]);
    const normal = concurrent[0]!;
    const corrected = concurrent[1]!;
    expect(normal.status).toBe("fulfilled");
    if (normal.status === "fulfilled") {
      expect(["RECORDED", "NOT_INSIDE"].includes(normal.value.body.outcome)).toBe(true);
      if (normal.value.body.outcome === "RECORDED") {
        expect(corrected.status).toBe("rejected");
        if (corrected.status === "rejected") {
          const failure = corrected.reason as { code?: string; status?: number };
          expect({ code: failure.code, status: failure.status }).toEqual({ code: "VERSION_CONFLICT", status: 409 });
        }
      } else {
        expect(corrected.status).toBe("fulfilled");
        if (corrected.status === "fulfilled") expect(corrected.value.version).toBe(open.version + 1);
      }
    }
    const stored = await db.attendanceVisit.findUniqueOrThrow({ where: { id: open.id } });
    expect(stored.exitedAt).not.toBeNull();
    expect(stored.version).toBe(open.version + 1);
  });

  it("誤記録の取消で在室を解消し、取消した記録の再有効化を拒否する", async () => {
    const admin = await administrator();
    const reception = await device();
    const person = await fixture();
    const time = await now();
    const visit = await createManualVisit(db, admin.actor, { personId: person.person.id, enteredAt: new Date(time.getTime() - 60_000).toISOString(), exitedAt: null, reason: "取消検証の準備" });
    const correction = { visitId: visit.id, expectedVersion: visit.version, enteredAt: visit.enteredAt, exitedAt: null, cancel: true, reason: "誤記録の取消" };
    const canceled = await correctAttendanceVisit(db, admin.actor, correction);
    expect(canceled.canceledAt).not.toBeNull();
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id, canceledAt: null, exitedAt: null } })).toBe(0);
    expect((await attempt(reception.actor, person.qr)).result.body.outcome).toBe("RECORDED");
    expect((await errorResult(() => correctAttendanceVisit(db, admin.actor, { ...correction, expectedVersion: canceled.version, cancel: false, reason: "取消解除の検証" })))?.code).toBe("VISIT_CANCELED");
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id, canceledAt: null, exitedAt: null } })).toBe(1);
    expect((await db.attendanceVisit.findUniqueOrThrow({ where: { id: visit.id } })).version).toBe(canceled.version);
  });

  it("在室中の停止を拒否し、停止と同時入室でも停止中の在室を作らない", async () => {
    const admin = await administrator();
    const reception = await device();
    const person = await fixture();
    await attempt(reception.actor, person.qr);
    expect((await errorResult(() => suspendPerson(db, admin.actor, person.person.id)))?.code).toBe("PERSON_INSIDE");
    expect((await db.person.findUniqueOrThrow({ where: { id: person.person.id } })).status).toBe("ACTIVE");
    await attempt(reception.actor, person.qr, "OUT");
    await suspendPerson(db, admin.actor, person.person.id);
    expect((await db.person.findUniqueOrThrow({ where: { id: person.person.id } })).status).toBe("SUSPENDED");
    expect(await db.qrCredential.count({ where: { personId: person.person.id, revokedAt: null } })).toBe(0);

    const other = await fixture();
    const ticket = await issueAttendanceRequest(db, reception.actor);
    await Promise.allSettled([
      recordAttendance(db, reception.actor, { requestId: ticket.requestId, mode: "IN", qr: other.qr }),
      suspendPerson(db, admin.actor, other.person.id),
    ]);
    const final = await db.person.findUniqueOrThrow({ where: { id: other.person.id } });
    const openCount = await db.attendanceVisit.count({ where: { personId: other.person.id, exitedAt: null, canceledAt: null } });
    expect(final.status === "SUSPENDED" ? openCount === 0 : final.status === "ACTIVE" && openCount === 1).toBe(true);
  });

  it("管理者以外は内部の手動追加・訂正・停止も実行できない", async () => {
    const user = await administrator("RECEPTION");
    const person = await fixture();
    const time = (await now()).toISOString();
    expect((await errorResult(() => createManualVisit(db, user.actor, { personId: person.person.id, enteredAt: time, exitedAt: null, reason: "権限検査" })))?.status).toBe(403);
    expect((await errorResult(() => correctAttendanceVisit(db, user.actor, { visitId: randomUUID(), expectedVersion: 1, enteredAt: time, exitedAt: null, cancel: true, reason: "権限検査" })))?.status).toBe(403);
    expect((await errorResult(() => suspendPerson(db, user.actor, person.person.id)))?.status).toBe(403);
  });
});

describe("DB制約・監査の保護・トランザクション", () => {
  it("DBも未終了一件・有効QR一件・時刻順・参照先・正の版を強制する", async () => {
    const person = await fixture();
    const time = await now();
    const open = await db.attendanceVisit.create({ data: { personId: person.person.id, enteredAt: new Date(time.getTime() - 60_000) } });
    expect(await rejected(() => db.attendanceVisit.create({ data: { personId: person.person.id, enteredAt: time } }))).toBe(true);
    expect(await rejected(() => db.qrCredential.create({ data: { personId: person.person.id, tokenHash: hash(newToken()) } }))).toBe(true);
    expect(await rejected(() => db.attendanceVisit.create({ data: { personId: person.person.id, enteredAt: time, exitedAt: new Date(time.getTime() - 1_000) } }))).toBe(true);
    expect(await rejected(() => db.attendanceVisit.create({ data: { personId: randomUUID(), enteredAt: time } }))).toBe(true);
    expect(await rejected(() => db.attendanceVisit.update({ where: { id: open.id }, data: { version: 0 } }))).toBe(true);
    expect(await rejected(() => db.person.delete({ where: { id: person.person.id } }))).toBe(true);
    await db.attendanceVisit.update({ where: { id: open.id }, data: { canceledAt: time } });
    await db.attendanceVisit.create({ data: { personId: person.person.id, enteredAt: time } });
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id, canceledAt: null, exitedAt: null } })).toBe(1);
  });

  it("施設一件・利用者コード一意・状態・要求の期限と結果列の整合を強制する", async () => {
    expect(await db.facility.count()).toBe(1);
    expect(await rejected(() => db.facility.create({ data: { id: 2, name: "追加施設" } }))).toBe(true);
    const code = randomUUID();
    await db.person.create({ data: { displayName: "一意コード確認", code } });
    expect(await rejected(() => db.person.create({ data: { displayName: "重複コード確認", code } }))).toBe(true);
    expect(await rejected(() => db.person.create({ data: { displayName: "不正状態確認", status: "UNKNOWN" } }))).toBe(true);
    const reception = await device();
    const time = await now();
    const ticket = { deviceId: reception.actor.deviceId, issuedAt: time, acceptUntil: new Date(time.getTime() + 300_000), resultUntil: new Date(time.getTime() + 86_400_000) };
    expect(await rejected(() => db.attendanceRequest.create({ data: { ...ticket, acceptUntil: time } }))).toBe(true);
    expect(await rejected(() => db.attendanceRequest.create({ data: { ...ticket, httpStatus: 200 } }))).toBe(true);
  });

  it("通常APIは監査・訂正履歴を追加/参照できるが、既存行の変更・削除はできない", async () => {
    const admin = await administrator();
    const person = await fixture();
    const time = await now();
    const visit = await createManualVisit(db, admin.actor, { personId: person.person.id, enteredAt: new Date(time.getTime() - 60_000).toISOString(), exitedAt: time.toISOString(), reason: "履歴権限の確認" });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { personId: person.person.id } });
    const revision = await db.attendanceRevision.findFirstOrThrow({ where: { visitId: visit.id } });
    expect(await rejected(() => db.$executeRaw`UPDATE "AuditEvent" SET action = action WHERE id = ${audit.id}::uuid`)).toBe(true);
    expect(await rejected(() => db.$executeRaw`DELETE FROM "AuditEvent" WHERE id = ${audit.id}::uuid`)).toBe(true);
    expect(await rejected(() => db.$executeRaw`UPDATE "AttendanceRevision" SET reason = reason WHERE id = ${revision.id}::uuid`)).toBe(true);
    expect(await rejected(() => db.$executeRaw`DELETE FROM "AttendanceRevision" WHERE id = ${revision.id}::uuid`)).toBe(true);
    expect(await db.auditEvent.count({ where: { id: audit.id } })).toBe(1);
    expect(await db.attendanceRevision.count({ where: { id: revision.id } })).toBe(1);
    await db.user.delete({ where: { id: admin.actor.userId } });
    expect((await db.attendanceRevision.findUniqueOrThrow({ where: { id: revision.id } })).actorUserId).toBeNull();
    expect(await db.auditEvent.count({ where: { id: audit.id } })).toBe(1);
  });

  it("監査の保存に失敗すると打刻・要求確定も全てロールバックする", async () => {
    const reception = await device();
    const person = await fixture();
    const ticket = await issueAttendanceRequest(db, reception.actor);
    // 対象tx内の後続書込だけを失敗させ、先行した在室更新が残らないことを確認する。
    let failureHookReached = false;
    const failing = db.$extends({ query: { auditEvent: { async create() { failureHookReached = true; throw new Error("監査保存失敗の検査"); } } } }) as unknown as Database;
    expect(await rejected(() => recordAttendance(failing, reception.actor, { requestId: ticket.requestId, mode: "IN", qr: person.qr }))).toBe(true);
    expect(failureHookReached).toBe(true);
    expect(await db.attendanceVisit.count({ where: { personId: person.person.id } })).toBe(0);
    const pending = await db.attendanceRequest.findUniqueOrThrow({ where: { id: ticket.requestId } });
    expect(pending.completedAt).toBeNull();
    expect(pending.payloadHash).toBeNull();
    expect(await db.auditEvent.count({ where: { requestId: ticket.requestId } })).toBe(0);
    expect((await recordAttendance(db, reception.actor, { requestId: ticket.requestId, mode: "IN", qr: person.qr })).body.outcome).toBe("RECORDED");
  });

  it("訂正履歴の保存に失敗すると元の時刻と版を維持する", async () => {
    const admin = await administrator();
    const person = await fixture();
    const time = (await now()).getTime();
    const visit = await createManualVisit(db, admin.actor, { personId: person.person.id, enteredAt: new Date(time - 60_000).toISOString(), exitedAt: new Date(time - 30_000).toISOString(), reason: "訂正失敗の準備" });
    const countBefore = await db.attendanceRevision.count({ where: { visitId: visit.id } });
    let failureHookReached = false;
    const failing = db.$extends({ query: { attendanceRevision: { async create() { failureHookReached = true; throw new Error("訂正履歴保存失敗の検査"); } } } }) as unknown as Database;
    expect(await rejected(() => correctAttendanceVisit(failing, admin.actor, { visitId: visit.id, expectedVersion: visit.version, enteredAt: new Date(time - 120_000).toISOString(), exitedAt: visit.exitedAt, cancel: false, reason: "失敗する訂正" }))).toBe(true);
    expect(failureHookReached).toBe(true);
    const stored = await db.attendanceVisit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(stored.enteredAt.toISOString()).toBe(visit.enteredAt);
    expect(stored.version).toBe(visit.version);
    expect(await db.attendanceRevision.count({ where: { visitId: visit.id } })).toBe(countBefore);
  });
});
