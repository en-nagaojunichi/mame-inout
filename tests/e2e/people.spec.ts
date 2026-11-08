import { test, expect, type Page } from "@playwright/test";
import type { PersonDetail } from "@mame/contracts";

const createdAt = "2026-11-08T00:00:00.000Z";
const personId = "0c6fa9c8-ea9c-4147-8ca9-8db583efc429";

function personDetail(overrides: Partial<PersonDetail> = {}): PersonDetail {
  return { id: personId, displayName: "画面確認の利用者", phoneticName: "がめんかくにん", affiliation: "確認用の組", code: "DEMO-01", status: "ACTIVE", version: 3, createdAt, updatedAt: createdAt, qrActive: false, ...overrides };
}

function summary(person: PersonDetail) {
  return { id: person.id, displayName: person.displayName, phoneticName: person.phoneticName, affiliation: person.affiliation, code: person.code, status: person.status };
}

async function mockPeople(page: Page) {
  const person = personDetail();
  const state = {
    authorized: true, recentAuth: true, currentUserId: "demo-admin", person,
    rows: [summary(person)], nextCursor: null as string | null,
    peopleRequests: 0, securityRequests: 0, detailRequests: 0, listFailure: false,
    queries: [] as Array<{ q: string | null; status: string | null; cursor: string | null }>,
    list: null as ((url: URL) => { items: Array<ReturnType<typeof summary>>; nextCursor: string | null }) | null,
  };
  // APIの認可・排他検査とは分け、架空の情報だけで失敗時の画面と操作を確認する。
  await page.route("**/api/admin/me", (route) => state.authorized ? route.fulfill({ json: {
    user: { id: state.currentUserId, name: "画面確認の管理者", email: "screen@example.test", emailVerified: false }, database: "connected",
  } }) : route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED", message: "パスキーでログインしてください。" } }));
  await page.route("**/api/admin/security", (route) => {
    state.securityRequests++;
    return route.fulfill({ json: {
      currentUserId: state.currentUserId, recentAuth: state.recentAuth, recoveryConfigured: true,
      passkeys: [{ id: "demo-key", name: "確認用のパスキー", createdAt, lastUsedAt: null }],
      admins: [{ id: state.currentUserId, name: "画面確認の管理者", email: "screen@example.test", emailVerified: false, status: "ACTIVE" }], adminsNextCursor: null,
    } });
  });
  await page.route("**/api/admin/devices", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route((url) => url.pathname === "/api/admin/people", (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "想定していない変更です。" } });
    state.peopleRequests++;
    const url = new URL(route.request().url());
    state.queries.push({ q: url.searchParams.get("q"), status: url.searchParams.get("status"), cursor: url.searchParams.get("cursor") });
    return state.listFailure ? route.abort("connectionreset") : route.fulfill({ json: state.list?.(url) ?? { items: state.rows, nextCursor: state.nextCursor } });
  });
  await page.route((url) => url.pathname === `/api/admin/people/${personId}`, (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "想定していない変更です。" } });
    state.detailRequests++;
    return route.fulfill({ json: state.person });
  });
  return state;
}

async function openPeople(page: Page) {
  await page.goto("/people");
  await expect(page.getByRole("heading", { name: "利用者", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "利用者を登録", exact: true })).toBeEnabled();
}

async function rejectPasskeyPrompt(page: Page) {
  const calls = { prompts: 0, options: 0 };
  await page.exposeFunction("countPeoplePasskeyPrompt", () => { calls.prompts++; });
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { countPeoplePasskeyPrompt: () => Promise<void> };
    Object.defineProperty(navigator.credentials, "get", { configurable: true, value: async () => {
      await testWindow.countPeoplePasskeyPrompt();
      throw new DOMException("本人確認をキャンセルしました。", "NotAllowedError");
    } });
  });
  await page.route("**/api/auth/passkey/generate-authenticate-options*", (route) => {
    calls.options++;
    return route.fulfill({ json: { challenge: "AQIDBA", rpId: new URL(route.request().url()).hostname, userVerification: "required", allowCredentials: [] } });
  });
  return calls;
}

test("未認証の管理枠では利用者一覧の取得と表示を行わない", async ({ page }) => {
  const state = await mockPeople(page);
  state.authorized = false;
  await page.goto("/people");
  await expect(page.getByRole("heading", { name: "管理者のログインが必要です", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "ログイン画面へ", exact: true })).toBeVisible();
  await expect(page.getByText(state.person.displayName, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "利用者を登録", exact: true })).toHaveCount(0);
  expect({ people: state.peopleRequests, security: state.securityRequests }).toEqual({ people: 0, security: 0 });
});

test("スマホの管理メニューで現在位置と自分・端末・管理者の設定を区別できる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPeople(page);
  await openPeople(page);
  const menu = page.locator(".admin-mobile-menu");
  await expect(menu.locator("summary")).toContainText("利用者");
  await menu.locator("summary").click();
  await expect(menu.getByRole("link", { name: "利用者", exact: true })).toHaveAttribute("aria-current", "page");
  await menu.getByRole("link", { name: "自分の設定", exact: true }).click();
  await expect(page.getByRole("heading", { name: "自分の設定", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "パスキー", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "QR受付に使う端末", exact: true })).toHaveCount(0);
  await menu.locator("summary").click();
  await menu.getByRole("link", { name: "QR受付端末", exact: true }).click();
  await expect(page.getByRole("heading", { name: "QR受付端末", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "パスキー", exact: true })).toHaveCount(0);
  await menu.locator("summary").click();
  await menu.getByRole("link", { name: "管理者", exact: true }).click();
  await expect(page.getByRole("heading", { name: "管理者", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "管理者を招待", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "復旧コード", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("利用者登録はキャンセルで送信せず、通信失敗後も入力を保って明示操作で再試行する", async ({ page }) => {
  const state = await mockPeople(page);
  let posts = 0;
  await page.route((url) => url.pathname === "/api/admin/people", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts++;
    if (posts === 1) return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "登録を完了できませんでした。もう一度お試しください。" } });
    const body = route.request().postDataJSON();
    state.person = personDetail({ displayName: body.displayName, affiliation: body.affiliation, code: body.code, phoneticName: body.phoneticName, version: 1 });
    state.rows = [summary(state.person)];
    return route.fulfill({ status: 201, json: state.person });
  });
  await openPeople(page);
  const register = page.getByRole("button", { name: "利用者を登録", exact: true });
  await register.click();
  const modal = page.getByRole("dialog", { name: "利用者を登録", exact: true });
  await expect(modal.getByRole("button", { name: "キャンセル", exact: true })).toBeFocused();
  await modal.getByLabel(/^表示名/).fill("登録確認の方");
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(register).toBeFocused();
  expect(posts).toBe(0);
  await register.click();
  await modal.getByLabel(/^表示名/).fill("登録確認の方");
  await modal.getByLabel(/^所属/).fill("確認用の所属");
  await modal.getByLabel(/^利用者コード/).fill("NEW-01");
  await modal.getByRole("button", { name: "登録", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("登録を完了できませんでした");
  await expect(modal.getByLabel(/^表示名/)).toHaveValue("登録確認の方");
  await expect(modal.getByLabel(/^所属/)).toHaveValue("確認用の所属");
  await expect(modal.getByLabel(/^利用者コード/)).toHaveValue("NEW-01");
  expect(posts).toBe(1);
  await modal.getByRole("button", { name: "登録", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByRole("heading", { name: /登録確認の方/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "登録した方のQRを発行", exact: true })).toBeVisible();
  expect(posts).toBe(2);
});

test("利用者編集の古い版は入力を保って再送を止め、キャンセル後は操作元へ戻る", async ({ page }) => {
  await mockPeople(page);
  let patches = 0;
  await page.route((url) => url.pathname === `/api/admin/people/${personId}`, (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    patches++;
    expect(route.request().postDataJSON().expectedVersion).toBe(3);
    return route.fulfill({ status: 409, json: { code: "VERSION_CONFLICT", message: "別の操作で更新されています。最新の状態を確認してください。" } });
  });
  await openPeople(page);
  const edit = page.getByRole("button", { name: /^編集\s*：\s*画面確認の利用者$/ });
  await edit.click();
  const modal = page.getByRole("dialog", { name: "利用者の情報を編集", exact: true });
  await modal.getByLabel(/^表示名/).fill("編集中の表示名");
  await modal.getByRole("button", { name: "保存", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("別の操作で更新されています");
  await expect(modal.getByLabel(/^表示名/)).toHaveValue("編集中の表示名");
  await expect(modal.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  expect(patches).toBe(1);
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(edit).toBeFocused();
});

test("QR発行前に本人確認が期限切れになった場合は自動認証せず、認証キャンセルでも発行しない", async ({ page }) => {
  const state = await mockPeople(page);
  const authentication = await rejectPasskeyPrompt(page);
  let issues = 0;
  await page.route(`**/api/admin/people/${personId}/qr-credentials`, (route) => {
    issues++;
    return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "発行してはいけない状態です。" } });
  });
  await openPeople(page);
  await page.getByRole("button", { name: /^QRコード\s*：/ }).click();
  const modal = page.getByRole("dialog", { name: "QRを発行", exact: true });
  state.recentAuth = false;
  await modal.getByRole("button", { name: "発行", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("本人確認の有効時間が過ぎました");
  expect({ issues, prompts: authentication.prompts, options: authentication.options }).toEqual({ issues: 0, prompts: 0, options: 0 });
  await modal.getByRole("button", { name: "本人確認して発行", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("本人確認は完了していません");
  expect({ issues, prompts: authentication.prompts }).toEqual({ issues: 0, prompts: 1 });
  await expect(modal).toBeVisible();
});

test("別の管理者へ切り替わった場合は以前の確認画面からQRを発行しない", async ({ page }) => {
  const state = await mockPeople(page);
  let issues = 0;
  await page.route(`**/api/admin/people/${personId}/qr-credentials`, (route) => {
    issues++;
    return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "発行してはいけない状態です。" } });
  });
  await openPeople(page);
  await page.getByRole("button", { name: /^QRコード\s*：/ }).click();
  const modal = page.getByRole("dialog", { name: "QRを発行", exact: true });
  state.currentUserId = "another-admin";
  await modal.getByRole("button", { name: "発行", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("ログインしている管理者が変わりました");
  await expect(modal.getByRole("button", { name: "発行", exact: true })).toBeDisabled();
  expect(issues).toBe(0);
});

test("QR発行APIが本人確認の期限切れを返した場合も自動再送せず明示操作を待つ", async ({ page }) => {
  const state = await mockPeople(page);
  const authentication = await rejectPasskeyPrompt(page);
  let issues = 0;
  await page.route(`**/api/admin/people/${personId}/qr-credentials`, (route) => {
    issues++; state.recentAuth = false;
    return route.fulfill({ status: 403, json: { code: "REAUTH_REQUIRED", message: "本人確認が必要です。" } });
  });
  await openPeople(page);
  await page.getByRole("button", { name: /^QRコード\s*：/ }).click();
  const modal = page.getByRole("dialog", { name: "QRを発行", exact: true });
  await modal.getByRole("button", { name: "発行", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("本人確認の有効時間が過ぎました");
  await expect(modal.getByRole("button", { name: "本人確認して発行", exact: true })).toBeEnabled();
  expect({ issues, prompts: authentication.prompts, options: authentication.options }).toEqual({ issues: 1, prompts: 0, options: 0 });
});

test("QR発行の応答が失われても自動再発行せず、同じ版の再試行は競合として止める", async ({ page }) => {
  const state = await mockPeople(page);
  let issues = 0;
  await page.route(`**/api/admin/people/${personId}/qr-credentials`, (route) => {
    issues++;
    expect(route.request().postDataJSON()).toEqual({ expectedVersion: 3 });
    if (issues === 1) {
      // サーバーでの発行確定後、本文だけが届かなかった状況を再現する。資格値は作らない。
      state.person = personDetail({ version: 4, qrActive: true });
      return route.abort("connectionreset");
    }
    return route.fulfill({ status: 409, json: { code: "VERSION_CONFLICT", message: "別の操作で更新されています。最新の状態を確認してください。" } });
  });
  await openPeople(page);
  await page.getByRole("button", { name: /^QRコード\s*：/ }).click();
  const modal = page.getByRole("dialog", { name: "QRを発行", exact: true });
  await modal.getByRole("button", { name: "発行", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("通信できませんでした");
  await expect(modal.getByRole("img")).toHaveCount(0);
  expect(issues).toBe(1);
  await modal.getByRole("button", { name: "発行", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("別の操作で更新されています");
  await expect(modal.getByRole("button", { name: "発行", exact: true })).toBeDisabled();
  expect(issues).toBe(2);
  await modal.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.getByRole("button", { name: /^QRコード\s*：/ }).click();
  const reissue = page.getByRole("dialog", { name: "QRを再発行", exact: true });
  await expect(reissue).toBeVisible();
  await expect(reissue.getByText(/以前に配った画像や紙のQRは直ちに使えなくなります/)).toBeVisible();
  expect(issues).toBe(2);
  await reissue.getByRole("button", { name: "現在のQRを失効", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "QRを失効", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^QRコード\s*：/ })).toBeFocused();
  expect(issues).toBe(2);
});

test("検索・状態・ページ分割を送信し、取得失敗では既存一覧を保ち、成功した空結果を区別する", async ({ page }) => {
  const state = await mockPeople(page);
  const second = personDetail({ id: "2a1df4ac-0a46-47ae-a59d-c5d066bb2af9", displayName: "次のページの利用者", code: "DEMO-02" });
  state.list = (url: URL) => url.searchParams.get("q") === "該当なし"
    ? { items: [], nextCursor: null }
    : url.searchParams.get("cursor") ? { items: [summary(second)], nextCursor: null } : { items: [summary(state.person)], nextCursor: personId };
  await openPeople(page);
  await page.getByRole("button", { name: "続きを表示", exact: true }).click();
  await expect(page.getByRole("heading", { name: /次のページの利用者/ })).toBeVisible();
  expect(state.queries.at(-1)?.cursor).toBe(personId);
  state.listFailure = true;
  await page.getByLabel("利用者を検索", { exact: true }).fill("通信失敗");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("通信できませんでした");
  await expect(page.getByRole("heading", { name: /画面確認の利用者/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /次のページの利用者/ })).toBeVisible();
  await expect(page.getByLabel("利用者を検索", { exact: true })).toHaveValue("通信失敗");
  await expect(page.getByText("条件に一致する利用者はいません。", { exact: true })).toHaveCount(0);
  state.listFailure = false;
  await page.getByLabel("利用者を検索", { exact: true }).fill("該当なし");
  await page.getByLabel("状態", { exact: true }).selectOption("SUSPENDED");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByText("条件に一致する利用者はいません。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /画面確認の利用者/ })).toHaveCount(0);
  expect(state.queries.at(-1)).toEqual({ q: "該当なし", status: "SUSPENDED", cursor: null });
});
