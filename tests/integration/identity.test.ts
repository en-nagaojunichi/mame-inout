import { afterAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createDatabase } from "../../apps/api/src/db.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createApp } from "../../apps/api/src/app.js";
import { hash, newToken } from "../../apps/api/src/setup.js";
import { receptionCookieName } from "../../apps/api/src/authorization.js";
import {
  beginInvitation, beginPasskeyAddition, beginRecovery, completeRegistration, disableAdministrator,
  generateRecoveryCodes, issueInvitation, renameAdministrator, renamePasskey, resolveRegistration, revokePasskey, validateAdminSession,
} from "../../apps/api/src/identity.js";

// 認証資格を変更する試験は、使い捨ての専用DBに限定する。
if (!/^mame-inout-test(?:-|$)/.test(process.env.TEST_PROJECT ?? "")) throw new Error("独立したテスト用Composeプロジェクトが必要です。");
const config = loadConfig();
const db = createDatabase(config);
const app = createApp(db, config);
const users: string[] = [];
const devices: string[] = [];
const registrationName = config.secure ? "__Secure-mame-registration" : "mame_registration";
const registrationHeaders = (token: string) => new Headers({ cookie: `${registrationName}=${token}` });

function sessionCookie(token: string) {
  const signature = createHmac("sha256", config.secret).update(token).digest("base64");
  return `${config.secure ? "__Secure-" : ""}better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function administrator() {
  try {
    const user = await db.user.create({ data: { id: randomUUID(), name: "認証管理の確認", email: `${randomUUID()}@example.test` } });
    users.push(user.id);
    const key = await db.passkey.create({ data: { id: randomUUID(), userId: user.id, name: "確認用パスキー", publicKey: "test-public-key", credentialID: randomUUID(), counter: 0, deviceType: "singleDevice", backedUp: false } });
    const token = newToken();
    const session = await db.session.create({ data: {
      id: randomUUID(), userId: user.id, token, expiresAt: new Date(Date.now() + 12 * 3_600_000), authenticatedAt: new Date(), passkeyId: key.id,
    } });
    return { user, key, session, actor: { userId: user.id, sessionId: session.id }, cookie: sessionCookie(token) };
  } catch {
    // ライブラリ例外へ検証用Cookieやトークンを含めない。
    throw new Error("検証用の管理者を準備できませんでした。");
  }
}

async function failed(operation: () => Promise<unknown>) {
  try { await operation(); return false; } catch { return true; }
}

async function register(token: string, afterVerification?: () => void, currentSessionId?: string) {
  const headers = registrationHeaders(token);
  const user = await resolveRegistration(db, headers);
  return db.$transaction(async (tx) => {
    await completeRegistration(tx, headers, user.id, currentSessionId);
    // WebAuthn署名そのものはE2Eで確認し、ここでは検証後の一括保存と失敗境界を検査する。
    afterVerification?.();
    const key = await tx.passkey.create({ data: { id: randomUUID(), userId: user.id, name: "新しい確認用パスキー", publicKey: "test-public-key", credentialID: randomUUID(), counter: 0, deviceType: "singleDevice", backedUp: false } });
    const session = await tx.session.create({ data: { id: randomUUID(), userId: user.id, token: newToken(), expiresAt: new Date(Date.now() + 12 * 3_600_000), authenticatedAt: new Date(), passkeyId: key.id } });
    if (!users.includes(user.id)) users.push(user.id);
    return { userId: user.id, key, session };
  });
}

afterAll(async () => {
  await db.receptionDevice.deleteMany({ where: { id: { in: devices } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

function api(path: string, body?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) {
  return app.request(path, { ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { origin: config.origin, ...(cookie ? { cookie } : {}), "content-type": "application/json", ...extraHeaders } });
}

describe("認証管理APIの公開境界", () => {
  it("全管理経路で未認証を拒否し、ライブラリ標準の管理経路も公開しない", async () => {
    const routes = [
      { path: "/api/admin/security", body: undefined },
      { path: "/api/admin/passkeys/begin", body: {} },
      { path: `/api/admin/passkeys/${randomUUID()}/name`, body: { name: "新しい名前" } },
      { path: `/api/admin/passkeys/${randomUUID()}/revoke`, body: {} },
      { path: "/api/admin/recovery-codes", body: {} },
      { path: "/api/admin/invitations", body: { name: "追加管理者", email: "invite@example.test" } },
      { path: `/api/admin/administrators/${randomUUID()}/name`, body: { name: "新しい名前" } },
      { path: `/api/admin/administrators/${randomUUID()}/disable`, body: {} },
    ];
    for (const route of routes) {
      const response = await api(route.path, route.body);
      expect(response.status, route.path).toBe(401);
      expect(response.headers.get("cache-control"), route.path).toBe("no-store");
    }
    expect((await api("/api/auth/passkey/delete-passkey", { id: randomUUID() })).status).toBe(404);
    expect((await api("/api/auth/passkey/update-passkey", { id: randomUUID(), name: "変更不可" })).status).toBe(404);
  });

  it("重要操作の再認証・Origin・厳密入力をHTTPでも検証する", async () => {
    const admin = await administrator();
    expect((await api("/api/admin/recovery-codes", {}, admin.cookie, { origin: "https://invalid.example" })).status).toBe(403);
    expect((await api("/api/admin/recovery-codes", { userId: randomUUID() }, admin.cookie)).status).toBe(422);
    await db.session.update({ where: { id: admin.session.id }, data: { authenticatedAt: new Date(Date.now() - 6 * 60_000) } });
    const response = await api("/api/admin/recovery-codes", {}, admin.cookie);
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("REAUTH_REQUIRED");
    expect((await api("/api/admin/security", undefined, admin.cookie)).status).toBe(200);
  });

  it("ログイン中の別管理者のブラウザから招待を消費させない", async () => {
    const admin = await administrator();
    const invitation = await issueInvitation(db, admin.actor, { name: "追加管理者", email: `${randomUUID()}@example.test` });
    const response = await api("/api/invitations/begin", { code: invitation.code }, admin.cookie, { "X-Mame-Client-IP": randomUUID() });
    expect(response.status).toBe(403);
    expect((await db.adminInvitation.findUniqueOrThrow({ where: { codeHash: hash(invitation.code) } })).usedAt).toBeNull();
  });

  it("復旧の推測を経路別に制限し、未登録メールでも同じ拒否を返す", async () => {
    const address = randomUUID();
    const statuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      const response = await api("/api/recovery/begin", { email: "unknown@example.test", code: newToken() }, undefined, { "X-Mame-Client-IP": address });
      statuses.push(response.status);
      if (response.status === 429) expect(response.headers.get("retry-after")).toBe("900");
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
  });

  it("管理者一覧を100件ずつ認可付きで取得し、全ページに重複・欠落を作らない", async () => {
    const admin = await administrator();
    const suffix = `${randomUUID()}@example.test`;
    const targets = Array.from({ length: 101 }, (_, index) => ({ id: randomUUID(), name: `一覧確認${index}`, email: `${index}.${suffix}` }));
    users.push(...targets.map((user) => user.id));
    await db.user.createMany({ data: targets });
    const found: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    do {
      const path: string = `/api/admin/security${cursor ? `?adminsCursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await api(path, undefined, admin.cookie);
      expect(response.status).toBe(200);
      const page = await response.json() as { admins: Array<{ id: string }>; adminsNextCursor: string | null };
      expect(page.admins.length).toBeLessThanOrEqual(100);
      found.push(...page.admins.map((user) => user.id));
      if (page.adminsNextCursor) expect(page.adminsNextCursor).not.toBe(cursor);
      cursor = page.adminsNextCursor;
      pageCount++;
    } while (cursor && pageCount < 10);
    expect(cursor).toBeNull();
    expect(pageCount).toBeGreaterThan(1);
    expect(new Set(found).size).toBe(found.length);
    expect(targets.every((target) => found.includes(target.id))).toBe(true);
    expect((await api(`/api/admin/security?adminsCursor=${targets[0]!.id}`)).status).toBe(401);
    expect((await api(`/api/admin/security?adminsCursor=${"x".repeat(129)}`, undefined, admin.cookie)).status).toBe(422);
  });
});

// 通常のHTTP操作で更新する利用時刻を除き、名前変更による資格・権限の変化を検出する。
async function administratorCredentials(userId: string) {
  const [user, passkeys, sessions, recoveryCodes] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, emailVerified: true, role: true, status: true, authVersion: true, image: true, createdAt: true } }),
    db.passkey.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    db.session.findMany({ where: { userId }, orderBy: { id: "asc" }, select: { id: true, userId: true, token: true, passkeyId: true, authenticatedAt: true, expiresAt: true, createdAt: true, ipAddress: true, userAgent: true } }),
    db.recoveryCode.findMany({ where: { userId }, orderBy: { codeHash: "asc" } }),
  ]);
  return JSON.stringify({ user, passkeys, sessions, recoveryCodes });
}

describe("管理者の表示名変更", () => {
  it("本人と他の管理者の名前だけを保存し、メール・権限・認証資格を保持する", async () => {
    const admin = await administrator();
    const other = await administrator();
    await generateRecoveryCodes(db, admin.actor);
    await generateRecoveryCodes(db, other.actor);
    for (const [target, name] of [[admin, "本人の新しい名前"], [other, "別の管理者の新しい名前"]] as const) {
      const before = await administratorCredentials(target.user.id);
      const response = await api(`/api/admin/administrators/${target.user.id}/name`, { name: `  ${name}  ` }, admin.cookie, { "X-Mame-Client-IP": randomUUID() });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ ok: true });
      expect((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).name).toBe(name);
      // 不一致でも試験出力へセッション資格や復旧コードのハッシュを表示しない。
      expect(await administratorCredentials(target.user.id) === before).toBe(true);
      const event = await db.auditEvent.findFirstOrThrow({ where: { action: "ADMIN_RENAMED", actorUserId: admin.user.id, details: { path: ["targetId"], equals: target.user.id } } });
      expect(event.details).toEqual({ targetId: target.user.id });
      expect((await api("/api/admin/me", undefined, target.cookie)).status).toBe(200);
    }
  });

  it("停止した管理者の名前も変更でき、停止状態と失効済み資格を保持する", async () => {
    const admin = await administrator();
    const target = await administrator();
    await disableAdministrator(db, admin.actor, target.user.id);
    const before = await administratorCredentials(target.user.id);
    const response = await api(`/api/admin/administrators/${target.user.id}/name`, { name: "停止済みの管理者" }, admin.cookie, { "X-Mame-Client-IP": randomUUID() });
    expect(response.status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).name).toBe("停止済みの管理者");
    expect(await administratorCredentials(target.user.id) === before).toBe(true);
    expect((await api("/api/admin/me", undefined, target.cookie)).status).toBe(401);
    expect(await failed(() => renameAdministrator(db, target.actor, admin.user.id, "停止後の変更"))).toBe(true);
  });

  it("有効なログインなら認証から5分後も変更でき、失効したセッションは保存時にも拒否する", async () => {
    const admin = await administrator();
    await db.session.update({ where: { id: admin.session.id }, data: { authenticatedAt: new Date(Date.now() - 6 * 60_000) } });
    expect((await api(`/api/admin/administrators/${admin.user.id}/name`, { name: "再認証不要の名前変更" }, admin.cookie, { "X-Mame-Client-IP": randomUUID() })).status).toBe(200);
    await db.session.delete({ where: { id: admin.session.id } });
    expect(await failed(() => renameAdministrator(db, admin.actor, admin.user.id, "失効後の変更"))).toBe(true);
    expect((await api(`/api/admin/administrators/${admin.user.id}/name`, { name: "失効後の変更" }, admin.cookie, { "X-Mame-Client-IP": randomUUID() })).status).toBe(401);
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.user.id } })).name).toBe("再認証不要の名前変更");
  });

  it("未認証と承認済み受付資格だけの操作を拒否する", async () => {
    const target = await administrator();
    const path = `/api/admin/administrators/${target.user.id}/name`;
    expect((await api(path, { name: "変更不可" }, undefined, { "X-Mame-Client-IP": randomUUID() })).status).toBe(401);
    const token = newToken();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const device = await db.receptionDevice.create({ data: { name: "権限確認の受付端末", status: "APPROVED", approvedAt: new Date(), expiresAt,
      credentials: { create: { tokenHash: hash(token), expiresAt } } } });
    devices.push(device.id);
    const response = await api(path, { name: "変更不可" }, `${receptionCookieName(config.secure)}=${token}`, { "X-Mame-Client-IP": randomUUID() });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).name).toBe(target.user.name);
  });

  it("空白・101文字・余分な権限やメールの入力を拒否し、100文字は保存する", async () => {
    const admin = await administrator();
    const path = `/api/admin/administrators/${admin.user.id}/name`;
    for (const input of [{ name: " \t\n " }, { name: "あ".repeat(101) }, { name: "変更不可", role: "RECEPTION" }, { name: "変更不可", email: "changed@example.test" }]) {
      expect((await api(path, input, admin.cookie, { "X-Mame-Client-IP": randomUUID() })).status).toBe(422);
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.user.id } })).name).toBe(admin.user.name);
    expect((await api(path, { name: "あ".repeat(100) }, admin.cookie, { "X-Mame-Client-IP": randomUUID() })).status).toBe(200);
  });

  it("存在しない管理者と管理者ではない対象は変更できない", async () => {
    const admin = await administrator();
    const target = await administrator();
    await db.user.update({ where: { id: target.user.id }, data: { role: "RECEPTION" } });
    for (const id of [randomUUID(), target.user.id]) {
      expect((await api(`/api/admin/administrators/${id}/name`, { name: "変更不可" }, admin.cookie, { "X-Mame-Client-IP": randomUUID() })).status).toBe(404);
    }
    expect((await api(`/api/admin/administrators/${admin.user.id}/name`, { name: "変更不可" }, target.cookie, { "X-Mame-Client-IP": randomUUID() })).status).toBe(403);
    expect(await failed(() => renameAdministrator(db, target.actor, admin.user.id, "権限なしの変更"))).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).name).toBe(target.user.name);
  });

  it("管理者同士が相手の名前を同時に変更しても両方を保存できる", async () => {
    const a = await administrator();
    const b = await administrator();
    await Promise.all([renameAdministrator(db, a.actor, b.user.id, "同時変更B"), renameAdministrator(db, b.actor, a.user.id, "同時変更A")]);
    expect((await db.user.findUniqueOrThrow({ where: { id: a.user.id } })).name).toBe("同時変更A");
    expect((await db.user.findUniqueOrThrow({ where: { id: b.user.id } })).name).toBe("同時変更B");
  });
});

describe("管理者セッションと再認証", () => {
  it("有効な操作で無操作期限を更新し、認証時刻を延長しない", async () => {
    const admin = await administrator();
    const lastActivityAt = new Date(Date.now() - 60_000);
    await db.session.update({ where: { id: admin.session.id }, data: { lastActivityAt } });
    const actor = await validateAdminSession(db, admin.session.id);
    expect(actor.userId).toBe(admin.user.id);
    const stored = await db.session.findUniqueOrThrow({ where: { id: admin.session.id } });
    expect(stored.lastActivityAt.getTime()).toBeGreaterThan(lastActivityAt.getTime());
    expect(stored.authenticatedAt?.getTime()).toBe(admin.session.authenticatedAt?.getTime());
  });

  it("無操作30分と絶対12時間をそれぞれ拒否する", async () => {
    for (const kind of ["idle", "absolute"]) {
      const admin = await administrator();
      await db.session.update({ where: { id: admin.session.id }, data: kind === "idle"
        ? { lastActivityAt: new Date(Date.now() - 31 * 60_000) }
        : { createdAt: new Date(Date.now() - 13 * 3_600_000), lastActivityAt: new Date() } });
      expect(await failed(() => validateAdminSession(db, admin.session.id))).toBe(true);
      const response = await app.request("/api/admin/me", { headers: { cookie: admin.cookie } });
      expect(response.status).toBe(401);
    }
  });

  it("通常操作できる古いセッションでも重要操作には5分以内の再認証を求める", async () => {
    const admin = await administrator();
    await db.session.update({ where: { id: admin.session.id }, data: { authenticatedAt: new Date(Date.now() - 6 * 60_000) } });
    expect((await validateAdminSession(db, admin.session.id)).userId).toBe(admin.user.id);
    expect(await failed(() => validateAdminSession(db, admin.session.id, true))).toBe(true);
    expect(await failed(() => issueInvitation(db, admin.actor, { name: "追加管理者", email: `${randomUUID()}@example.test` }))).toBe(true);
    expect(await failed(() => generateRecoveryCodes(db, admin.actor))).toBe(true);
    expect(await failed(() => beginPasskeyAddition(db, admin.actor))).toBe(true);
  });

  it("認証時刻のない既存セッションや、失効済みセッションを重要操作へ使えない", async () => {
    const admin = await administrator();
    await db.session.update({ where: { id: admin.session.id }, data: { authenticatedAt: null } });
    expect(await failed(() => validateAdminSession(db, admin.session.id, true))).toBe(true);
    await db.session.delete({ where: { id: admin.session.id } });
    expect(await failed(() => generateRecoveryCodes(db, admin.actor))).toBe(true);
  });
});

describe("単回招待と登録の原子性", () => {
  it("既存の大文字メールと同じ小文字メールへの招待を重複として拒否する", async () => {
    const admin = await administrator();
    await db.user.update({ where: { id: admin.user.id }, data: { email: admin.user.email.toUpperCase() } });
    let code: unknown = null;
    try { await issueInvitation(db, admin.actor, { name: "重複招待の確認", email: admin.user.email.toLowerCase() }); }
    catch (error) { code = (error as { code?: unknown }).code; }
    expect(code).toBe("EMAIL_IN_USE");
  });

  it("招待はハッシュ保存し、パスキー確定前に管理者を作らない", async () => {
    const admin = await administrator();
    const email = `${randomUUID()}@example.test`;
    const invitation = await issueInvitation(db, admin.actor, { name: "招待された管理者", email });
    const attempt = await beginInvitation(db, { code: invitation.code });
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(await db.adminInvitation.count({ where: { codeHash: hash(invitation.code) } })).toBe(1);
    const identity = await resolveRegistration(db, registrationHeaders(attempt.token));
    expect(identity.name).toBe(email);
    const registered = await register(attempt.token);
    expect((await db.user.findUniqueOrThrow({ where: { id: registered.userId } })).emailVerified).toBe(false);
    expect(await failed(() => beginInvitation(db, { code: invitation.code }))).toBe(true);
  });

  it("同じ招待を別ブラウザで同時確定しても管理者は1人だけになる", async () => {
    const admin = await administrator();
    const email = `${randomUUID()}@example.test`;
    const invitation = await issueInvitation(db, admin.actor, { name: "同時招待の確認", email });
    const [a, b] = await Promise.all([beginInvitation(db, { code: invitation.code }), beginInvitation(db, { code: invitation.code })]);
    const results = await Promise.allSettled([register(a.token), register(b.token)]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(await db.user.count({ where: { email } })).toBe(1);
    expect(await db.passkey.count({ where: { user: { email } } })).toBe(1);
  });

  it("期限切れ招待と、登録開始後に期限切れになった申請を拒否する", async () => {
    const admin = await administrator();
    const invitation = await issueInvitation(db, admin.actor, { name: "期限確認", email: `${randomUUID()}@example.test` });
    const attempt = await beginInvitation(db, { code: invitation.code });
    await db.adminInvitation.updateMany({ where: { codeHash: hash(invitation.code) }, data: { createdAt: new Date(0), expiresAt: new Date(1) } });
    expect(await failed(() => beginInvitation(db, { code: invitation.code }))).toBe(true);
    expect(await failed(() => register(attempt.token))).toBe(true);
  });

  it("後続のパスキー保存失敗では招待消費と管理者作成も戻す", async () => {
    const admin = await administrator();
    const email = `${randomUUID()}@example.test`;
    const invitation = await issueInvitation(db, admin.actor, { name: "保存失敗確認", email });
    const attempt = await beginInvitation(db, { code: invitation.code });
    let reached = false;
    expect(await failed(() => register(attempt.token, () => { reached = true; throw new Error("後続保存の失敗を注入"); }))).toBe(true);
    expect(reached).toBe(true);
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect((await db.adminInvitation.findUniqueOrThrow({ where: { codeHash: hash(invitation.code) } })).usedAt).toBeNull();
    expect(await failed(() => register(attempt.token))).toBe(false);
  });
});

describe("復旧限定セッションと旧資格失効", () => {
  it("旧版で大文字メールを保存した管理者も、小文字入力で復旧を開始できる", async () => {
    const admin = await administrator();
    await db.user.update({ where: { id: admin.user.id }, data: { email: admin.user.email.toUpperCase() } });
    const codes = await generateRecoveryCodes(db, admin.actor);
    const attempt = await beginRecovery(db, { email: admin.user.email.toLowerCase(), code: codes[0]! });
    const identity = await resolveRegistration(db, registrationHeaders(attempt.token));
    expect(identity.id).toBe(admin.user.id);
  });

  it("復旧コードは一度だけ消費し、限定Cookieでは管理APIを使えない", async () => {
    const admin = await administrator();
    const codes = await generateRecoveryCodes(db, admin.actor);
    expect(codes.length).toBeGreaterThan(1);
    const results = await Promise.allSettled([0, 1].map(() => beginRecovery(db, { email: admin.user.email, code: codes[0]! })));
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const attempt = results.find((item) => item.status === "fulfilled");
    if (!attempt || attempt.status !== "fulfilled") throw new Error("復旧申請を作成できませんでした。");
    expect((await app.request("/api/admin/me", { headers: registrationHeaders(attempt.value.token) })).status).toBe(401);
    expect(await db.passkey.count({ where: { id: admin.key.id } })).toBe(1);
    expect(await db.session.count({ where: { id: admin.session.id } })).toBe(1);
  });

  it("復旧確定時に旧パスキー・全セッション・全復旧コードを失効する", async () => {
    const admin = await administrator();
    const codes = await generateRecoveryCodes(db, admin.actor);
    const attempt = await beginRecovery(db, { email: admin.user.email, code: codes[0]! });
    const registered = await register(attempt.token);
    expect(registered.userId).toBe(admin.user.id);
    expect(await db.passkey.count({ where: { id: admin.key.id } })).toBe(0);
    expect(await db.session.count({ where: { id: admin.session.id } })).toBe(0);
    expect(await db.passkey.count({ where: { userId: admin.user.id } })).toBe(1);
    expect(await db.session.count({ where: { userId: admin.user.id } })).toBe(1);
    expect(await db.recoveryCode.count({ where: { userId: admin.user.id } })).toBe(0);
    expect((await app.request("/api/admin/me", { headers: { cookie: admin.cookie } })).status).toBe(401);
    expect(await failed(() => beginRecovery(db, { email: admin.user.email, code: codes[1]! }))).toBe(true);
    expect(await failed(() => register(attempt.token))).toBe(true);
  });

  it("復旧確定後の保存失敗では旧資格を保持し、限定申請をやり直せる", async () => {
    const admin = await administrator();
    const codes = await generateRecoveryCodes(db, admin.actor);
    const attempt = await beginRecovery(db, { email: admin.user.email, code: codes[0]! });
    let reached = false;
    expect(await failed(() => register(attempt.token, () => { reached = true; throw new Error("後続保存の失敗を注入"); }))).toBe(true);
    expect(reached).toBe(true);
    expect(await db.passkey.count({ where: { id: admin.key.id } })).toBe(1);
    expect(await db.session.count({ where: { id: admin.session.id } })).toBe(1);
    expect(await failed(() => register(attempt.token))).toBe(false);
  });

  it("別々のコードで始めた復旧も同時確定では一方だけを許可する", async () => {
    const admin = await administrator();
    const codes = await generateRecoveryCodes(db, admin.actor);
    const [a, b] = await Promise.all(codes.slice(0, 2).map((code) => beginRecovery(db, { email: admin.user.email, code })));
    const results = await Promise.allSettled([register(a!.token), register(b!.token)]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(await db.passkey.count({ where: { userId: admin.user.id } })).toBe(1);
    expect(await db.session.count({ where: { userId: admin.user.id } })).toBe(1);
  });

  it("復旧コード再発行で旧コードを使えなくする", async () => {
    const admin = await administrator();
    const oldCodes = await generateRecoveryCodes(db, admin.actor);
    const newCodes = await generateRecoveryCodes(db, admin.actor);
    expect(await failed(() => beginRecovery(db, { email: admin.user.email, code: oldCodes[0]! }))).toBe(true);
    expect(await failed(() => beginRecovery(db, { email: admin.user.email, code: newCodes[0]! }))).toBe(false);
  });

  it("復旧コードの再発行で、旧コードから開始済みの限定申請も失効する", async () => {
    const admin = await administrator();
    const oldCodes = await generateRecoveryCodes(db, admin.actor);
    const attempt = await beginRecovery(db, { email: admin.user.email, code: oldCodes[0]! });
    await generateRecoveryCodes(db, admin.actor);
    expect(await failed(() => register(attempt.token))).toBe(true);
    expect(await db.passkey.count({ where: { id: admin.key.id } })).toBe(1);
  });
});

describe("パスキーと管理者の保護", () => {
  it("最後のパスキーを削除できず、他人のパスキーの名前・失効も変更できない", async () => {
    const admin = await administrator();
    const other = await administrator();
    expect(await failed(() => revokePasskey(db, admin.actor, admin.key.id))).toBe(true);
    expect(await failed(() => renamePasskey(db, admin.actor, other.key.id, "変更不可"))).toBe(true);
    expect(await failed(() => revokePasskey(db, admin.actor, other.key.id))).toBe(true);
    await renamePasskey(db, admin.actor, admin.key.id, "自分のパスキー");
    expect((await db.passkey.findUniqueOrThrow({ where: { id: admin.key.id } })).name).toBe("自分のパスキー");
  });

  it("同じ管理者のパスキーを同時に失効しても1つを残す", async () => {
    const admin = await administrator();
    const second = await db.passkey.create({ data: { id: randomUUID(), userId: admin.user.id, name: "2つめ", publicKey: "test-public-key", credentialID: randomUUID(), counter: 0, deviceType: "singleDevice", backedUp: false } });
    const secondSession = await db.session.create({ data: { id: randomUUID(), userId: admin.user.id, token: newToken(), expiresAt: new Date(Date.now() + 60_000), authenticatedAt: new Date(), passkeyId: second.id } });
    // 独立した2つの有効セッションを使い、片方のCookie失効だけでは競合を防げない条件にする。
    const results = await Promise.allSettled([
      revokePasskey(db, admin.actor, admin.key.id),
      revokePasskey(db, { userId: admin.user.id, sessionId: secondSession.id }, second.id),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(await db.passkey.count({ where: { userId: admin.user.id } })).toBe(1);
  });

  it("開始後に元セッションを失効した追加登録を確定できない", async () => {
    const admin = await administrator();
    const token = await beginPasskeyAddition(db, admin.actor);
    await db.session.delete({ where: { id: admin.session.id } });
    expect(await failed(() => register(token))).toBe(true);
    expect(await db.passkey.count({ where: { userId: admin.user.id } })).toBe(1);
  });

  it("パスキー追加は開始元の管理者セッションでだけ確定できる", async () => {
    const admin = await administrator();
    const token = await beginPasskeyAddition(db, admin.actor);
    expect(await failed(() => register(token, undefined, randomUUID()))).toBe(true);
    expect(await failed(() => register(token, undefined, admin.session.id))).toBe(false);
    expect(await db.passkey.count({ where: { userId: admin.user.id } })).toBe(2);
  });

  it("パスキーが20件に達した管理者の追加登録を拒否し、既存の手段を保持する", async () => {
    const admin = await administrator();
    await db.passkey.createMany({ data: Array.from({ length: 19 }, (_, index) => ({
      id: randomUUID(), userId: admin.user.id, name: `上限確認${index}`, publicKey: "test-public-key",
      credentialID: randomUUID(), counter: 0, deviceType: "singleDevice", backedUp: false,
    })) });
    const token = await beginPasskeyAddition(db, admin.actor);
    let code: unknown = null;
    try { await register(token, undefined, admin.session.id); } catch (error) { code = (error as { code?: unknown }).code; }
    expect(code).toBe("PASSKEY_LIMIT");
    expect(await db.passkey.count({ where: { userId: admin.user.id } })).toBe(20);
    expect(await db.session.count({ where: { id: admin.session.id } })).toBe(1);
  });

  it("管理者を無効化すると既存Cookieも管理APIに使えない", async () => {
    const admin = await administrator();
    const other = await administrator();
    await disableAdministrator(db, admin.actor, other.user.id);
    expect((await app.request("/api/admin/me", { headers: { cookie: other.cookie } })).status).toBe(401);
    expect(await failed(() => validateAdminSession(db, other.session.id))).toBe(true);
  });

  it("異なる管理者の同時停止でも最後の有効管理者を残す", async () => {
    const a = await administrator();
    const b = await administrator();
    // 同一ファイル内の他の検証用管理者を一時停止し、最後の2人の競合を実DBで再現する。
    const others = await db.user.findMany({ where: { role: "ADMIN", status: "ACTIVE", id: { notIn: [a.user.id, b.user.id] } }, select: { id: true } });
    await db.user.updateMany({ where: { id: { in: others.map((user) => user.id) } }, data: { status: "DISABLED" } });
    try {
      const results = await Promise.allSettled([disableAdministrator(db, a.actor, a.user.id), disableAdministrator(db, b.actor, b.user.id)]);
      expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(await db.user.count({ where: { role: "ADMIN", status: "ACTIVE" } })).toBe(1);
      const active = await db.user.findFirstOrThrow({ where: { role: "ADMIN", status: "ACTIVE" } });
      const remaining = active.id === a.user.id ? a : b;
      expect(await failed(() => disableAdministrator(db, remaining.actor, remaining.user.id))).toBe(true);
    } finally {
      await db.user.updateMany({ where: { id: { in: others.map((user) => user.id) } }, data: { status: "ACTIVE" } });
    }
  });
});
