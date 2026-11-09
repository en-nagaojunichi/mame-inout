import { expect, type Locator, type Page } from "@playwright/test";

// 初回読込と追加ページの描画完了を待ち、公開UIだけで承認対象を探す。
// 新しい申請もID順では後方ページへ入るため、先頭ページだけで有無を判断しない。
export async function findDeviceApproval(page: Page, deviceName: string): Promise<Locator> {
  const devices = page.getByRole("region", { name: "QR受付に使う端末", exact: true });
  await expect(devices).toBeVisible();
  const rows = devices.locator(".item-list > li");
  const approval = rows.filter({ hasText: deviceName }).getByRole("button", { name: /^承認/ });
  const more = devices.getByRole("button", { name: "続きを表示", exact: true });

  for (let index = 0; index < 20 && !await approval.count(); index++) {
    if (!await more.count()) break;
    const previousCount = await rows.count();
    await more.click();
    // 応答ヘッダーの受信だけではJSON読取やReactの描画は終わらない。
    // 行の追加かページング終了が画面へ反映されてから、次の探索へ進む。
    await expect.poll(async () => (await rows.count()) > previousCount || (await more.count()) === 0, {
      message: "端末一覧の次ページが画面に反映されませんでした。",
    }).toBe(true);
  }

  await expect(approval).toBeVisible();
  await expect(approval).toBeEnabled();
  return approval;
}
