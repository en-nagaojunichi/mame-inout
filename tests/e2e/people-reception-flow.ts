import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import QRCode from "qrcode";
import { qrIssueResponseSchema } from "@mame/contracts";
import { fakeCamera } from "./fake-camera";
import { findDeviceApproval } from "./device-approval";

// 認証済み管理者と独立した受付ブラウザで、実API・DB・QRデコーダを通して検査する。
// パスキーは仮想認証器、映像は架空カメラであり、スマホ実機の確認とは区別する。
export async function runPeopleReceptionFlow(admin: BrowserContext, browser: Browser, baseURL: string) {
  const page = await admin.newPage();
  const receptionPage = await admin.request.get("/reception");
  expect(receptionPage.headers()["permissions-policy"]).toContain("camera=(self)");
  const personName = "QR受付の通し確認";
  const code = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  let issuedQr = "";
  await page.route("**/api/admin/people/*/qr-credentials", async route => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    const response = await route.fetch().catch(async () => {
      await route.abort().catch(() => undefined);
      throw new Error("QR発行の検証用通信を完了できませんでした。");
    });
    if (!response.ok()) { await route.fulfill({ response }); return; }
    const value = qrIssueResponseSchema.safeParse(await response.json());
    if (!value.success) { await route.abort(); throw new Error("QR発行の応答を確認できませんでした。"); }
    issuedQr = value.data.qr;
    // QR保存・印刷の画面にも実資格を置かず、同形式の表示用ダミーへ置換する。
    await route.fulfill({ response, json: { ...value.data, qr: `mio1_${"A".repeat(43)}` } });
  });
  await page.goto("/people");
  await page.getByRole("button", { name: "利用者を登録", exact: true }).click();
  const create = page.getByRole("dialog", { name: "利用者を登録", exact: true });
  await create.getByLabel(/^表示名/).fill(personName);
  await create.getByLabel(/^所属/).fill("動作確認用");
  await create.getByLabel(/^利用者コード/).fill(code);
  await create.getByRole("button", { name: "登録", exact: true }).click();
  await expect(create).not.toBeVisible();
  await page.getByRole("button", { name: "登録した方のQRを発行", exact: true }).click();
  const issue = page.getByRole("dialog", { name: "QRを発行", exact: true });
  await issue.getByRole("button", { name: "発行", exact: true }).click();
  const qr = page.getByRole("dialog", { name: "QRコードを保存", exact: true });
  await expect(qr.getByRole("img")).toBeVisible();
  expect(/^mio1_[A-Za-z0-9_-]{43}$/.test(issuedQr)).toBe(true);
  await page.evaluate(() => { window.print = () => { document.documentElement.dataset.printInvoked = "yes"; }; });
  await qr.getByRole("button", { name: "印刷", exact: true }).click();
  expect(await page.locator("html").getAttribute("data-print-invoked")).toBe("yes");
  await qr.getByRole("button", { name: "保存したので閉じる", exact: true }).click();
  await expect(page.getByRole("img", { name: /受付用QRコード/ })).toHaveCount(0);
  await page.getByLabel("利用者を検索", { exact: true }).fill(code);
  await page.getByRole("button", { name: "検索", exact: true }).click();
  const person = page.locator(".people-list > li").filter({ hasText: personName });
  await expect(person).toHaveCount(1);
  await person.getByRole("button", { name: /^編集/ }).click();
  const edit = page.getByRole("dialog", { name: "利用者の情報を編集", exact: true });
  await edit.getByLabel(/^ふりがな/).fill("うけつけかくにん");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await expect(edit).not.toBeVisible();

  const reception = await browser.newContext({ baseURL });
  try {
    const receiver = await reception.newPage();
    let frame: string | null = null;
    const image = await QRCode.toDataURL(issuedQr, { margin: 4, width: 480 });
    await fakeCamera(receiver, async () => frame);
    await receiver.goto("/device");
    const deviceName = `受付確認-${code}`;
    await receiver.getByLabel("端末名", { exact: true }).fill(deviceName);
    await receiver.getByRole("button", { name: "管理者へ承認を申請", exact: true }).click();
    await expect(receiver.getByText("承認を待っています", { exact: true })).toBeVisible();
    await page.goto("/settings/devices");
    const approvalButton = await findDeviceApproval(page, deviceName);
    await approvalButton.click();
    const approval = page.getByRole("dialog", { name: "受付端末を承認", exact: true });
    await approval.getByRole("button", { name: "承認", exact: true }).click();
    await expect(approval).not.toBeVisible();
    await receiver.getByRole("button", { name: "承認の状態を確認", exact: true }).click();
    await receiver.getByRole("button", { name: "このブラウザで利用を開始", exact: true }).click();
    await receiver.getByRole("link", { name: "QR受付を開く", exact: true }).click();
    await expect(receiver.getByRole("button", { name: "入室", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect((await reception.request.get("/api/admin/people")).status()).toBe(403);

    let records = 0;
    const requestIds = new Set<string>();
    await receiver.route("**/api/reception/records", async route => {
      records++; requestIds.add(route.request().postDataJSON().requestId);
      if (records === 1) {
        // DB確定後に応答だけを失わせ、成功を断定せず同じ要求の結果を照会する。
        const response = await route.fetch().catch(async () => {
          await route.abort().catch(() => undefined);
          throw new Error("受付の検証用通信を完了できませんでした。");
        });
        if (!response.ok()) { await route.fulfill({ response }); return; }
        await route.abort("failed"); return;
      }
      await route.continue();
    });
    await receiver.getByRole("button", { name: "カメラを起動", exact: true }).click();
    frame = image;
    try {
      await expect(receiver.getByRole("heading", { name: "この受付の結果を確認してください", exact: true })).toBeVisible({ timeout: 20_000 });
    } catch (error) {
      // 画像・QR・Cookieを採取せず、カメラと送信の段階だけを診断できるようにする。
      await test.info().attach("reception-stage", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        records, camera: await receiver.locator(".camera-status").textContent(), alerts: await receiver.getByRole("alert").allTextContents(),
        video: await receiver.locator("video").evaluate((element: HTMLVideoElement) => ({ ready: element.readyState, width: element.videoWidth, height: element.videoHeight })),
      })) });
      throw error;
    }
    await expect(receiver.getByRole("heading", { name: "入室を記録しました", exact: true })).toHaveCount(0);
    expect(records).toBe(1);
    expect(await receiver.evaluate(() => ({ local: localStorage.length, keys: Object.keys(sessionStorage), safe: /^[0-9a-f-]{36}$/i.test(sessionStorage.getItem("mame.reception.pending-request") ?? "") }))).toEqual({ local: 0, keys: ["mame.reception.pending-request"], safe: true });
    await receiver.getByRole("button", { name: "この受付の結果を確認", exact: true }).click();
    await expect(receiver.getByRole("heading", { name: "入室を記録しました", exact: true })).toBeVisible();
    expect(records).toBe(1);
    const present = await (await admin.request.get("/api/admin/presence?limit=100")).json();
    expect(present.items.filter((item: { person: { displayName: string } }) => item.person.displayName === personName).length).toBe(1);

    frame = null;
    await expect(receiver.getByRole("heading", { name: "入室を記録しました", exact: true })).toHaveCount(0, { timeout: 10_000 });
    await expect(receiver.getByText("QRをカメラにかざしてください", { exact: true })).toBeVisible();
    // 同じQRをいったん外す操作をカメラの白フレームで再現する。
    await receiver.waitForTimeout(1_500);
    expect(records).toBe(1);
    await receiver.getByRole("button", { name: "退室", exact: true }).click();
    await expect(receiver.getByRole("button", { name: "退室", exact: true })).toHaveAttribute("aria-pressed", "true");
    frame = image;
    await expect(receiver.getByRole("heading", { name: "退室を記録しました", exact: true })).toBeVisible();
    expect({ records, requests: requestIds.size }).toEqual({ records: 2, requests: 2 });
    const history = await (await admin.request.get("/api/admin/attendance?limit=100")).json();
    const visit = history.items.filter((item: { person: { displayName: string } }) => item.person.displayName === personName);
    expect(visit.length).toBe(1); expect(Boolean(visit[0]?.exitedAt)).toBe(true);
    expect(await receiver.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  } finally { await reception.close(); await page.close(); }
}
