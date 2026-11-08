import { test, expect, type Page } from "@playwright/test";
import type { Appearance } from "@mame/contracts";

const originalName = "確認室の入退出";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDZwAAAAASUVORK5CYII=", "base64");

async function mockAppearance(page: Page) {
  const state = {
    current: { displayName: originalName, version: 7, iconUrl: "/api/appearance/icon?v=7", faviconUrl: "/api/appearance/favicon?v=7", customIcon: true, customFavicon: true } as Appearance,
    authorized: true, readFailure: false, readRequests: 0, writeStatus: 200, writes: [] as Array<Record<string, unknown>>,
  };
  // 画像と設定はすべて架空の値にし、実機の認証情報や施設の画像を使用しない。
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "確認用APIの対象外です。" } }));
  await page.route("**/api/admin/me", (route) => state.authorized ? route.fulfill({ json: {
    user: { id: "screen-admin", name: "表示設定の管理者", email: "screen@example.test", emailVerified: false }, database: "connected",
  } }) : route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED", message: "パスキーでログインしてください。" } }));
  await page.route((url) => url.pathname === "/api/appearance", (route) => route.fulfill({ json: state.current }));
  await page.route((url) => ["/api/appearance/icon", "/api/appearance/favicon"].includes(url.pathname), (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route((url) => url.pathname === "/api/admin/appearance", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>; state.writes.push(body);
      if (state.writeStatus !== 200) return route.fulfill({ status: state.writeStatus, json: {
        code: state.writeStatus === 409 ? "VERSION_CONFLICT" : "UNAVAILABLE",
        message: state.writeStatus === 409 ? "別の管理者が表示設定を変更しました。現在の設定を読み直してください。" : "保存を確認できませんでした。入力内容を保持しています。",
      } });
      const version = Number(body.expectedVersion) + 1;
      state.current = { displayName: body.displayName as string, version, iconUrl: `/api/appearance/icon?v=${version}`, faviconUrl: `/api/appearance/favicon?v=${version}`,
        customIcon: body.iconPng === undefined ? state.current.customIcon : body.iconPng !== null,
        customFavicon: body.faviconPng === undefined ? state.current.customFavicon : body.faviconPng !== null };
      return route.fulfill({ json: state.current });
    }
    state.readRequests++;
    return state.readFailure ? route.abort("connectionreset") : route.fulfill({ json: state.current });
  });
  return state;
}

test("表示設定の初回取得に失敗しても既定値を保存済みと見せず、読み直して現在値を表示する", async ({ page }) => {
  const state = await mockAppearance(page); state.readFailure = true;
  await page.goto("/settings/appearance");
  await expect(page.getByRole("heading", { name: "表示設定", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("通信できませんでした");
  await expect(page.getByLabel("システムの表示名", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toHaveCount(0);
  state.readFailure = false;
  await page.getByRole("button", { name: "表示設定を読み直す", exact: true }).click();
  await expect(page.getByLabel("システムの表示名", { exact: true })).toHaveValue(originalName);
  expect(state.readRequests).toBe(2);
  expect(state.writes).toHaveLength(0);
});

test("表示名は保存前にプレビューでき、保存後に共通ヘッダー・タブ名・ファビコン版へ反映する", async ({ page }) => {
  const state = await mockAppearance(page);
  await page.goto("/settings/appearance");
  const name = page.getByLabel("システムの表示名", { exact: true });
  await expect(name).toHaveValue(originalName);
  await name.fill("新しい施設の受付");
  const preview = page.getByRole("complementary", { name: "表示のプレビュー", exact: true });
  await expect(preview).toContainText("新しい施設の受付");
  await expect(page.locator(".admin-header")).toContainText(originalName);
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("表示設定を保存しました");
  await expect(page.locator(".admin-header")).toContainText("新しい施設の受付");
  await expect(page).toHaveTitle("表示設定 | 新しい施設の受付");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/api/appearance/favicon?v=8");
  expect(state.writes).toEqual([{ expectedVersion: 7, displayName: "新しい施設の受付" }]);
});

test("初回の古い表示設定が保存後に届いても新しい名前・ファビコンを巻き戻さない", async ({ page }) => {
  const state = await mockAppearance(page);
  const old = { ...state.current };
  let initialRequests = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === "/api/appearance", async (route) => {
    initialRequests++; await held; await route.fulfill({ json: old });
  });
  try {
    await page.goto("/settings/appearance");
    await expect.poll(() => initialRequests).toBe(1);
    const name = page.getByLabel("システムの表示名", { exact: true });
    await expect(name).toHaveValue(originalName);
    await name.fill("古い応答から守る新しい名前");
    await page.getByRole("button", { name: "変更を保存", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("表示設定を保存しました");
    await expect(page.locator(".admin-header")).toContainText("古い応答から守る新しい名前");
    const arrived = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/appearance");
    release();
    await (await arrived).finished();
    // 受信したJSONとReactの更新が処理される描画まで待ち、旧応答到着前の値だけで合格にしない。
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(name).toHaveValue("古い応答から守る新しい名前");
    await expect(page.locator(".admin-header")).toContainText("古い応答から守る新しい名前");
    await expect(page).toHaveTitle("表示設定 | 古い応答から守る新しい名前");
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/api/appearance/favicon?v=8");
    expect(state.writes).toHaveLength(1);
  } finally { release(); }
});

test("表示設定の通信失敗後は入力を保ち、明示した再試行で保存する", async ({ page }) => {
  const state = await mockAppearance(page); state.writeStatus = 503;
  await page.goto("/settings/appearance");
  const name = page.getByLabel("システムの表示名", { exact: true });
  await expect(name).toHaveValue(originalName);
  await name.fill("保存をやり直す施設名");
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("入力内容を保持");
  await expect(name).toHaveValue("保存をやり直す施設名");
  await expect(page.locator(".admin-header")).toContainText(originalName);
  expect(state.writes).toHaveLength(1);
  state.writeStatus = 200;
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("表示設定を保存しました");
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
});

test("表示設定の競合は入力を保持して上書きを止め、明示的な読み直しで現在値へ切り替える", async ({ page }) => {
  const state = await mockAppearance(page); state.writeStatus = 409;
  await page.goto("/settings/appearance");
  const name = page.getByLabel("システムの表示名", { exact: true });
  await expect(name).toHaveValue(originalName);
  await name.fill("保持する編集中の名前");
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("別の管理者");
  await expect(name).toHaveValue("保持する編集中の名前");
  await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toBeDisabled();
  await expect(page.getByText(/未保存の入力を置き換えます/)).toBeVisible();
  state.current = { ...state.current, displayName: "別の管理者が保存した名前", version: 8, iconUrl: "/api/appearance/icon?v=8", faviconUrl: "/api/appearance/favicon?v=8" };
  await page.getByRole("button", { name: "現在の設定を読み直す", exact: true }).click();
  await expect(name).toHaveValue("別の管理者が保存した名前");
  await expect(page.locator(".admin-header")).toContainText("別の管理者が保存した名前");
  expect(state.writes).toHaveLength(1);
});

test("既定値への復帰はモーダルで対象と未保存を説明し、保存まで反映しない", async ({ page }) => {
  const state = await mockAppearance(page);
  await page.goto("/settings/appearance");
  const reset = page.getByRole("button", { name: "すべて既定に戻す", exact: true });
  await reset.click();
  const modal = page.getByRole("dialog", { name: "表示を既定に戻す", exact: true });
  await expect(modal).toContainText("表示名・システムアイコン・ファビコン");
  await expect(modal).toContainText("反映は「変更を保存」の後");
  await expect(modal.getByRole("button", { name: "キャンセル", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(reset).toBeFocused();
  expect(state.writes).toHaveLength(0);
  await reset.click();
  await modal.getByRole("button", { name: "既定の表示を使う", exact: true }).click();
  await expect(page.getByLabel("システムの表示名", { exact: true })).toHaveValue("入退出管理システム");
  await expect(page.locator(".admin-header")).toContainText(originalName);
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(page.locator(".admin-header")).toContainText("入退出管理システム");
  expect(state.writes).toEqual([{ expectedVersion: 7, displayName: "入退出管理システム", iconPng: null, faviconPng: null }]);
});

test("PNG以外の画像は保存せず案内し、選んだPNGはプレビュー後にだけ送信する", async ({ page }) => {
  const state = await mockAppearance(page);
  await page.goto("/settings/appearance");
  await expect(page.getByLabel("システムの表示名", { exact: true })).toHaveValue(originalName);
  const input = page.getByLabel("システムアイコンのPNG", { exact: true });
  await input.setInputFiles({ name: "invalid.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await expect(page.getByRole("main").getByRole("alert")).toContainText("PNGファイルを選択");
  expect(state.writes).toHaveLength(0);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext("2d")!; context.fillStyle = "#2D6252"; context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await input.setInputFiles({ name: "screen-icon.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") });
  await expect(page.getByRole("img", { name: "選択したシステムアイコン", exact: true })).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("表示設定を保存しました");
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ expectedVersion: 7, displayName: originalName, iconPng: expect.any(String) });
  expect(state.writes[0]).not.toHaveProperty("faviconPng");
});
