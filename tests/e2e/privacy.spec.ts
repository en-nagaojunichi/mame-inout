import { test, expect, type Page } from "@playwright/test";
import type { PrivacyResponse } from "@mame/contracts";

const now = "2026-11-08T01:00:00.000Z", personId = "0c6fa9c8-ea9c-4147-8ca9-8db583efc429";
async function mockPrivacy(page: Page) {
  const state = { current: { retention: { days: 365, version: 1, backupRetentionDays: 30, lastRunAt: null, lastDeletedVisits: 0, lastDeletedAuditEvents: 0 }, deletions: [], pendingCount: 0 } as PrivacyResponse,
    writes: [] as Record<string, unknown>[], writeFailure: false, openVisits: 0, loadFailure: false };
  await page.route("**/api/admin/me", (route) => route.fulfill({ json: { user: { id: "screen-admin", name: "確認用管理者", email: "screen@example.test", emailVerified: false }, database: "connected" } }));
  await page.route("**/api/admin/security", (route) => route.fulfill({ json: { currentUserId: "screen-admin", recentAuth: true, recoveryConfigured: true, passkeys: [], admins: [], adminsNextCursor: null } }));
  await page.route("**/api/admin/privacy", (route) => state.loadFailure ? route.abort() : route.fulfill({ json: state.current }));
  await page.route("**/api/admin/privacy/retention-preview", (route) => route.fulfill({ json: { days: route.request().postDataJSON().days, expectedVersion: 1, cutoff: now, visits: 12, revisions: 3, auditEvents: 7, openVisits: 2, confirmationToken: "screen-only-confirmation" } }));
  await page.route("**/api/admin/privacy/retention", (route) => {
    const body = route.request().postDataJSON(); state.writes.push(body);
    if (state.writeFailure) return route.fulfill({ status: 409, json: { code: "PREVIEW_CHANGED", message: "対象件数が変わりました。もう一度確認してください。" } });
    state.current.retention = { ...state.current.retention, days: body.days, version: 2 };
    return route.fulfill({ json: state.current });
  });
  await page.route(`**/api/admin/people/${personId}/deletion-preview`, (route) => route.fulfill({ json: { personId, version: 2, displayName: "削除確認の利用者", visits: 3, revisions: 1, openVisits: state.openVisits, backupRetentionDays: 30 } }));
  await page.route(`**/api/admin/people/${personId}/deletion`, (route) => {
    const body = route.request().postDataJSON(); state.writes.push(body);
    if (state.writeFailure) return route.abort("connectionreset");
    return route.fulfill({ status: 202, json: { operationId: body.operationId, personId, requestedAt: now, state: "PENDING", completedAt: null, errorCode: null } });
  });
  return state;
}
test("保持期間の対象件数と未退室保護を確認し、キャンセルでは保存しない", async ({ page }) => {
  const state = await mockPrivacy(page);
  await page.goto("/settings/privacy");
  await page.getByLabel("記録を残す日数").fill("30");
  const open = page.getByRole("button", { name: "削除予定件数を確認", exact: true });
  await open.click();
  const modal = page.getByRole("dialog", { name: "保存期間の変更を確認", exact: true });
  await expect(modal).toContainText("12件（訂正履歴3件）"); await expect(modal).toContainText("2件は削除しません");
  await page.keyboard.press("Escape"); await expect(modal).not.toBeVisible(); await expect(open).toBeFocused();
  expect(state.writes.length).toBe(0); await expect(page.getByLabel("記録を残す日数")).toHaveValue("30");
});
test("保持の保存競合ではモーダルに失敗を表示し、再確認後に保存する", async ({ page }) => {
  const state = await mockPrivacy(page); state.writeFailure = true;
  await page.goto("/settings/privacy"); await page.getByLabel("記録を残す日数").fill("30");
  await page.getByRole("button", { name: "削除予定件数を確認", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "保存期間の変更を確認", exact: true });
  await modal.getByRole("button", { name: "本人確認して保存", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("対象件数が変わりました");
  await modal.getByRole("button", { name: "件数の確認に戻る", exact: true }).click(); state.writeFailure = false;
  await page.getByRole("button", { name: "削除予定件数を確認", exact: true }).click();
  await modal.getByRole("button", { name: "本人確認して保存", exact: true }).click();
  await expect(modal).not.toBeVisible(); await expect(page.getByRole("main")).toContainText("現在は30日です");
});
test("保存設定を取得できないときに既定値を編集して保存できない", async ({ page }) => {
  const state = await mockPrivacy(page); state.loadFailure = true;
  await page.goto("/settings/privacy"); await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("記録を残す日数")).toHaveCount(0); expect(state.writes.length).toBe(0);
});
test("個人情報の削除は影響を専用ページで示し、受付202を完了と表示しない", async ({ page }) => {
  const state = await mockPrivacy(page);
  await page.goto(`/people/${personId}/deletion`); await expect(page.getByRole("main")).toContainText("完全な匿名化ではありません");
  await page.getByRole("button", { name: "影響を確認して削除へ進む", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "本人確認して削除を指示", exact: true }).click();
  await expect(page.getByRole("heading", { name: "削除指示を受け付けました", exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("まだ完了していません"); expect(state.writes.length).toBe(1);
});
test("未退室の個人情報削除を止め、履歴の確認へ案内する", async ({ page }) => {
  const state = await mockPrivacy(page); state.openVisits = 1;
  await page.goto(`/people/${personId}/deletion`);
  await expect(page.getByRole("button", { name: "影響を確認して削除へ進む", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "対象者の履歴へ", exact: true })).toBeVisible(); expect(state.writes.length).toBe(0);
});
test("削除指示の通信失敗後は同じ処理番号で再試行する", async ({ page }) => {
  const state = await mockPrivacy(page); state.writeFailure = true;
  await page.goto(`/people/${personId}/deletion`); await page.getByRole("button", { name: "影響を確認して削除へ進む", exact: true }).click();
  const submit = page.getByRole("dialog").getByRole("button", { name: "本人確認して削除を指示", exact: true });
  await submit.click(); await expect(page.getByRole("dialog").getByRole("alert")).toContainText("通信できませんでした");
  state.writeFailure = false; await submit.click(); await expect(page.getByRole("heading", { name: "削除指示を受け付けました", exact: true })).toBeVisible();
  expect(state.writes[0]?.operationId === state.writes[1]?.operationId).toBe(true);
});
