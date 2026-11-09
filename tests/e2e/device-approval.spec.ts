import { test, expect, type Page } from "@playwright/test";
import type { DeviceSummary, DevicesResponse } from "@mame/contracts";
import { findDeviceApproval } from "./device-approval";

const firstId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";
const targetName = "後方ページの受付スマートフォン";
const createdAt = "2026-11-09T00:00:00.000Z";
const device = (id: string, name: string): DeviceSummary => ({
  id, name, status: "PENDING", confirmationCode: "1234ABCD", applicationExpiresAt: "2026-11-09T12:00:00.000Z",
  expiresAt: null, approvedAt: null, lastUsedAt: null, createdAt,
});

// 架空の一覧応答で探索の待機条件を確認する。実認証・QR受付は同じヘルパーを通す別のE2Eで検査する。
async function mockSettings(page: Page, devices: (cursor: string | null) => Promise<DevicesResponse>) {
  await page.route("**/api/admin/me", route => route.fulfill({ json: {
    user: { id: "demo-admin", name: "動作確認の管理者", email: "demo@example.test", emailVerified: false }, database: "connected",
  } }));
  await page.route("**/api/admin/security", route => route.fulfill({ json: {
    currentUserId: "demo-admin", recoveryConfigured: true, recentAuth: true, passkeys: [],
    admins: [{ id: "demo-admin", name: "動作確認の管理者", email: "demo@example.test", emailVerified: false, status: "ACTIVE" }],
  } }));
  await page.route(/\/api\/admin\/devices(?:\?.*)?$/, async route => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({ json: await devices(cursor) });
  });
}

test("初回一覧の読込を待ち、次ページの承認対象を探す", async ({ page }) => {
  let finishInitial!: () => void;
  const initial = new Promise<void>(resolve => { finishInitial = resolve; });
  const cursors: string[] = [];
  await mockSettings(page, async cursor => {
    if (cursor === null) {
      await initial;
      return { items: [device(firstId, "既存の申請")], nextCursor: firstId };
    }
    cursors.push(cursor);
    return { items: [device(targetId, targetName)], nextCursor: null };
  });
  await page.goto("/settings/devices");
  await expect(page.getByText("設定を読み込んでいます…", { exact: true })).toBeVisible();
  const [approval] = await Promise.all([
    findDeviceApproval(page, targetName),
    Promise.resolve().then(finishInitial),
  ]);
  await approval.click();
  await expect(page.getByRole("dialog", { name: "受付端末を承認", exact: true })).toBeVisible();
  expect(cursors).toEqual([firstId]);
});

test("次ページの応答受信後も、JSON読取と一覧の描画を待つ", async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as typeof window & { devicePageBodyWaiting?: boolean; finishDevicePageBody?: () => void };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const address = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
      if (address.pathname === "/api/admin/devices" && address.searchParams.has("cursor")) {
        const readJson = response.json.bind(response);
        // ヘッダー到着と本文の読取完了を分離し、受信だけを待つ旧手順の競合条件を作る。
        response.json = async () => {
          scope.devicePageBodyWaiting = true;
          await new Promise<void>(resolve => { scope.finishDevicePageBody = resolve; });
          return readJson();
        };
      }
      return response;
    };
  });
  await mockSettings(page, async cursor => cursor === null
    ? { items: [device(firstId, "既存の申請")], nextCursor: firstId }
    : { items: [device(targetId, targetName)], nextCursor: null });
  await page.goto("/settings/devices");
  const [approval] = await Promise.all([
    findDeviceApproval(page, targetName),
    (async () => {
      await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { devicePageBodyWaiting?: boolean }).devicePageBodyWaiting))).toBe(true);
      await expect(page.getByRole("button", { name: "続きを表示", exact: true })).toBeDisabled();
      await page.evaluate(() => (window as typeof window & { finishDevicePageBody?: () => void }).finishDevicePageBody?.());
    })(),
  ]);
  await approval.click();
  await expect(page.getByRole("dialog", { name: "受付端末を承認", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "続きを表示", exact: true })).toHaveCount(0);
});

test("先頭ページに承認対象があれば、不要な追加読込を行わない", async ({ page }) => {
  const cursors: string[] = [];
  await mockSettings(page, async cursor => {
    if (cursor !== null) cursors.push(cursor);
    return { items: [device(targetId, targetName)], nextCursor: firstId };
  });
  await page.goto("/settings/devices");
  const approval = await findDeviceApproval(page, targetName);
  await approval.click();
  await expect(page.getByRole("dialog", { name: "受付端末を承認", exact: true })).toBeVisible();
  expect(cursors).toEqual([]);
});
