import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { DiagnosticsResponse, PrivacyResponse } from "@mame/contracts";

const { version: distributionVersion } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const checkedAt = "2026-11-08T01:00:00.000Z";
const personId = "0c6fa9c8-ea9c-4147-8ca9-8db583efc429";
const operationId = "615c80ad-19f7-490b-a0a9-f049c7dcfe1f";

async function mockWorkspace(page: Page) {
  const appearance = { displayName: "入退出管理システム", version: 1, iconUrl: "/api/appearance/icon?v=1", faviconUrl: "/api/appearance/favicon?v=1", customIcon: false, customFavicon: false };
  const privacy: PrivacyResponse = {
    retention: { days: 365, version: 1, backupRetentionDays: 30, lastRunAt: null, lastDeletedVisits: 0, lastDeletedAuditEvents: 0 },
    deletions: [{ operationId, personId, requestedAt: checkedAt, state: "PENDING", completedAt: null, errorCode: "EXTERNAL_STORAGE_UNAVAILABLE" }], pendingCount: 1,
  };
  const diagnostics: DiagnosticsResponse = {
    checkedAt, origin: "https://screen.example.test", https: true, database: "connected", passkey: { rpId: "screen.example.test", userVerification: "required" },
    disk: { availableBytes: 2 * 1024 ** 3, totalBytes: 4 * 1024 ** 3, scope: "container" },
    backup: { lastCompletedAt: null, externalConfirmed: false, retentionDays: 30 }, privacy: { pendingDeletions: 1, lastRetentionRunAt: null },
  };
  const state = {
    denied: false, peopleFailure: false, unexpected: [] as string[], peopleWrites: 0,
    save: null as ((route: Route) => Promise<void>) | null,
  };
  // この組はブラウザの操作・意味付けだけを確認する。全APIを架空応答へ隔離し、実データや実際の認可検査と混同しない。
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === "/api/appearance" || path === "/api/admin/appearance") return json(appearance);
    if (path === "/api/appearance/favicon" || path === "/api/appearance/icon") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2d6252"/></svg>' });
    if (path === "/api/admin/me") return json({ user: { id: "screen-admin", name: "画面確認の管理者", email: "screen@example.test", emailVerified: false }, database: "connected" });
    if (path === "/api/admin/security") return json({ currentUserId: "screen-admin", recentAuth: true, recoveryConfigured: true, passkeys: [], admins: [], adminsNextCursor: null });
    if (path === "/api/admin/dashboard") return json({ timeZone: "Asia/Tokyo", asOf: checkedAt, counts: { inside: 0, needsReview: 0, todayEntered: 0, todayExited: 0 }, recent: [] });
    if (path === "/api/admin/presence") return json({ label: "記録上の在室者", timeZone: "Asia/Tokyo", asOf: checkedAt, total: 0, items: [], nextCursor: null });
    if (path === "/api/admin/attendance") return json({ timeZone: "Asia/Tokyo", asOf: checkedAt, total: 0, items: [], nextCursor: null });
    if (path === "/api/admin/devices") return json({ items: [], nextCursor: null });
    if (path === "/api/admin/people") {
      if (method !== "GET") { state.peopleWrites++; return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "登録を確認できませんでした。入力を残したまま再確認してください。" } }); }
      return state.peopleFailure ? route.abort("connectionreset") : json({ items: [], nextCursor: null });
    }
    if (path === "/api/admin/privacy" || path === "/api/admin/diagnostics") {
      if (state.denied) return route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED", message: "ログインの有効期限が切れました。パスキーでログインし直してください。" } });
      return json(path.endsWith("privacy") ? privacy : diagnostics);
    }
    if (path === "/api/admin/privacy/retention-preview") return json({ days: request.postDataJSON().days, expectedVersion: 1, cutoff: checkedAt, visits: 12, revisions: 3, auditEvents: 7, openVisits: 2, confirmationToken: "screen-only-preview" });
    if (path === "/api/admin/privacy/retention" && state.save) return state.save(route);
    if (path === `/api/admin/people/${personId}/deletion-preview`) return json({ personId, version: 2, displayName: "削除確認の利用者", visits: 3, revisions: 1, openVisits: 0, backupRetentionDays: 30 });
    if (path === "/api/devices/current") return route.fulfill({ status: 401, json: { code: "DEVICE_REQUIRED", message: "受付端末の登録が必要です。" } });
    if (path === "/api/devices/application") return route.fulfill({ status: 404, json: { code: "APPLICATION_NOT_FOUND", message: "申請はありません。" } });
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 503, json: { code: "UNEXPECTED_REQUEST", message: "画面検査で想定していない要求です。" } });
  });
  return state;
}

async function keyboardActivate(page: Page, target: Locator) {
  // focus()で目的の操作へ飛ばさず、実際のTab順序から到達できることを確かめる。
  for (let index = 0; index < 70; index++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) { await page.keyboard.press("Enter"); return; }
  }
  throw new Error("目的の操作へTabキーで到達できませんでした。");
}

async function expectWithinViewport(page: Page) {
  const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  expect(layout.width).toBeLessThanOrEqual(layout.viewport + 1);
}

const mainPages = [
  ["/admin", "管理ホーム"], ["/presence", "記録上の在室者"], ["/attendance", "入退室履歴"], ["/people", "利用者"],
  ["/settings/devices", "QR受付端末"], ["/settings/administrators", "管理者"], ["/settings", "自分の設定"],
  ["/settings/appearance", "表示設定"], ["/settings/privacy", "保存と削除"], ["/settings/diagnostics", "稼働状況"],
  [`/people/${personId}/deletion`, "個人情報の削除"],
] as const;

for (const width of [320, 390, 1280]) {
  test(`${width}pxの管理主要画面に本文・見出し・入力名があり、横にはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await mockWorkspace(page);
    for (const [path, title] of mainPages) {
      await page.goto(path);
      const main = page.getByRole("main");
      await expect(main).toHaveCount(1);
      await expect(main.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
      await expect(main.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page).toHaveTitle(new RegExp(title === "記録上の在室者" ? "在室一覧" : title));
      await expect(page.locator(".app-version")).toContainText(`バージョン ${distributionVersion}`);
      await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(main.getByRole("status").filter({ hasText: /読み込|取得して|確認しています/ })).toHaveCount(0);
      const inputs = main.locator("input:not([type=hidden]),select,textarea");
      for (const input of await inputs.all()) if (await input.isVisible()) await expect(input).toHaveAccessibleName(/\S/);
      for (const button of await main.getByRole("button").all()) if (await button.isVisible()) {
        await expect(button).toHaveAccessibleName(/\S/);
        const box = await button.boundingBox();
        expect(box?.height, `${path}のボタンの高さ`).toBeGreaterThanOrEqual(44);
      }
      await expectWithinViewport(page);
    }
    expect(state.unexpected).toEqual([]);
  });
}

test("本文へのスキップから管理ホームの初回3工程へキーボードだけで進める", async ({ page }) => {
  const state = await mockWorkspace(page);
  for (const [linkName, heading] of [["利用者を登録・確認", "利用者"], ["端末の申請を確認", "QR受付端末"], ["このブラウザのQR受付を開く", "QR受付"]]) {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "はじめての受付準備", exact: true })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "本文へ移動", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    expect(await page.getByRole("main").evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await keyboardActivate(page, page.getByRole("link", { name: linkName, exact: true }));
    await expect(page.getByRole("heading", { name: heading, level: 1, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("main")).toContainText("受付端末");
  expect(state.unexpected).toEqual([]);
});

test("登録モーダルは入力エラーを項目へ関連付け、通信失敗でも入力を残して戻れる", async ({ page }) => {
  const state = await mockWorkspace(page);
  await page.goto("/people");
  const opener = page.getByRole("button", { name: "利用者を登録", exact: true });
  await opener.click();
  const modal = page.getByRole("dialog", { name: "利用者を登録", exact: true });
  await expect(modal).toHaveAccessibleDescription("表示名を入力してください。ふりがな・所属・利用者コードは任意です。");
  const name = modal.getByLabel("表示名", { exact: false });
  await name.fill("   ");
  await modal.getByRole("button", { name: "登録", exact: true }).click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription("表示名を1〜100文字で入力してください。");
  await expect(modal.getByRole("alert")).toHaveText("入力内容を確認してください。");
  expect(state.peopleWrites).toBe(0);
  await name.fill("入力を保持する確認用の人");
  await modal.getByLabel("所属", { exact: false }).fill("架空の組");
  await modal.getByRole("button", { name: "登録", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("入力を残したまま再確認");
  await expect(name).toHaveValue("入力を保持する確認用の人");
  await expect(modal.getByLabel("所属", { exact: false })).toHaveValue("架空の組");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(state.peopleWrites).toBe(1);
  expect(state.unexpected).toEqual([]);
});

test("保存処理中はモーダルから背景へ移動せず、失敗後は件数確認へ戻れる", async ({ page }) => {
  const state = await mockWorkspace(page);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.save = async (route) => { await gate; await route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "保存を確認できませんでした。" } }); };
  await page.goto("/settings/privacy");
  await page.getByLabel("記録を残す日数").fill("30");
  const opener = page.getByRole("button", { name: "削除予定件数を確認", exact: true });
  await opener.click();
  const modal = page.getByRole("dialog", { name: "保存期間の変更を確認", exact: true });
  const back = modal.getByRole("button", { name: "件数の確認に戻る", exact: true });
  await expect(back).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(modal.getByRole("button", { name: "本人確認して保存", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(modal.getByRole("button", { name: "保存しています…", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  for (let count = 0; count < 3; count++) {
    await page.keyboard.press("Tab");
    expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  // ブラウザのモーダル機構が、背景へ直接フォーカスする操作も抑止していることを確かめる。
  await page.getByRole("link", { name: "管理ホーム", exact: true }).evaluate((element) => (element as HTMLElement).focus());
  expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  release?.();
  await expect(modal.getByRole("alert")).toContainText("件数の確認に戻って");
  await page.keyboard.press("Tab");
  await expect(back).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(modal).not.toBeVisible();
  await expect(opener).toBeFocused();
  await expect(page.getByLabel("記録を残す日数")).toHaveValue("30");
  expect(state.unexpected).toEqual([]);
});

for (const [path, buttonName, protectedText] of [["/settings/privacy", "処理状態を更新", operationId], ["/settings/diagnostics", "状況を更新", "https://screen.example.test"]]) {
  test(`${path}の認証期限切れでは古い保護情報を隠し、再読込後に復帰できる`, async ({ page }) => {
    const state = await mockWorkspace(page);
    await page.goto(path);
    const main = page.getByRole("main");
    await expect(main).toContainText(protectedText);
    state.denied = true;
    await main.getByRole("button", { name: buttonName, exact: true }).click();
    await expect(main.getByRole("alert")).toContainText("ログインし直してください");
    await expect(main).not.toContainText(protectedText);
    if (path.endsWith("privacy")) await expect(main.getByLabel("記録を残す日数")).toHaveCount(0);
    state.denied = false;
    await main.getByRole("button", { name: path.endsWith("privacy") ? "設定を読み直す" : buttonName, exact: true }).click();
    await expect(main).toContainText(protectedText);
    expect(state.unexpected).toEqual([]);
  });
}

test("一覧の通信失敗は空の名簿として案内せず、再確認後に登録手順を示す", async ({ page }) => {
  const state = await mockWorkspace(page); state.peopleFailure = true;
  await page.goto("/people");
  const main = page.getByRole("main");
  await expect(main.getByRole("alert")).toContainText("通信できませんでした");
  await expect(main).not.toContainText("利用者はまだ登録されていません");
  state.peopleFailure = false;
  await keyboardActivate(page, main.getByRole("button", { name: "一覧を更新", exact: true }));
  await expect(main).toContainText("「利用者を登録」から、表示名を入力して登録してください。");
  await expect(main.getByRole("alert")).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
});
