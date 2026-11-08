import { test, expect, type Page, type Route } from "@playwright/test";
import QRCode from "qrcode";
import { fakeCamera } from "./fake-camera";

const requestId = "5d227bf3-febc-4218-b493-943fbbe2e94a";
const otherRequestId = "b9a26d56-19ce-4a73-97d9-9e9d59bcab52";
const dummyQr = `mio1_${"A".repeat(43)}`;
const storageKey = "mame.reception.pending-request";
const recordedAt = "2026-11-08T01:02:03.000Z";

function completed(mode: "IN" | "OUT" = "IN") {
  return { requestId, mode, outcome: "RECORDED", message: mode === "IN" ? "入室を記録しました。" : "退室を記録しました。",
    recordedAt, person: { displayName: "カメラ試験の利用者" }, timeZone: "Asia/Tokyo" };
}

async function mockDevice(page: Page, approved = true) {
  await page.route("**/api/devices/current", (route) => approved ? route.fulfill({ json: {
    claimed: true, device: {
      id: "bc793e0c-a311-4e8c-9b4c-4558118a49f0", name: "動作確認の受付", status: "APPROVED",
      confirmationCode: null, applicationExpiresAt: null, expiresAt: "2099-11-08T02:00:00.000Z",
      approvedAt: recordedAt, lastUsedAt: null, createdAt: recordedAt,
    },
  } }) : route.fulfill({ status: 401, json: { code: "DEVICE_UNAUTHENTICATED", message: "このブラウザには有効な受付端末の登録がありません。" } }));
}

async function mockRequests(page: Page, options: {
  mode?: "IN" | "OUT";
  record?: (route: Route, call: number) => Promise<void>;
  lookup?: (route: Route) => Promise<void>;
} = {}) {
  const acceptUntil = new Date(Date.now() + 5 * 60_000).toISOString();
  const calls = { tickets: 0, records: 0, lookups: 0, correctPayload: true, sameContent: true, correctLookup: true };
  let firstBody: string | null = null;
  await page.route("**/api/reception/requests", async (route) => {
    calls.tickets++;
    await route.fulfill({ status: 201, json: { requestId, acceptUntil, resultUntil: new Date(Date.now() + 86_400_000).toISOString() } });
  });
  await page.route("**/api/reception/records", async (route) => {
    calls.records++;
    const body = route.request().postDataJSON() as { requestId?: unknown; mode?: unknown; qr?: unknown };
    // 固定の架空QRもassertのexpected/actualへ複製せず、形式・同一内容の判定結果だけを残す。
    calls.correctPayload &&= body.requestId === requestId && body.mode === (options.mode ?? "IN") && body.qr === dummyQr &&
      Object.keys(body).sort().join(",") === "mode,qr,requestId";
    const serialized = route.request().postData();
    if (firstBody === null) firstBody = serialized;
    else calls.sameContent &&= serialized === firstBody;
    if (options.record) await options.record(route, calls.records);
    else await route.fulfill({ json: completed(options.mode) });
  });
  await page.route("**/api/reception/requests/*", async (route) => {
    calls.lookups++;
    calls.correctLookup &&= new URL(route.request().url()).pathname.endsWith(`/${requestId}`);
    if (options.lookup) await options.lookup(route);
    else await route.fulfill({ json: { state: "pending", acceptUntil } });
  });
  return calls;
}

async function fixedFrame() {
  return QRCode.toDataURL(dummyQr, { width: 480, margin: 4, errorCorrectionLevel: "M" });
}

async function startCamera(page: Page) {
  await page.goto("/reception");
  await page.getByRole("button", { name: "カメラを起動", exact: true }).click();
}

async function storageSummary(page: Page) {
  return page.evaluate(({ key, id }) => ({
    onlyRequestId: sessionStorage.length === 1 && sessionStorage.getItem(key) === id,
    localStorageEmpty: localStorage.length === 0,
  }), { key: storageKey, id: requestId });
}

// 架空のAPIとCanvasのカメラ映像でUIの拒否・通信失敗を検査する。
// 実APIの署名検証・DB整合性・iOS/Androidカメラの結果は、この試験へ置き換えない。
test("未承認のブラウザではカメラを起動せず、端末登録への入口を案内する", async ({ page }) => {
  await mockDevice(page, false);
  let cameraCalls = 0;
  await page.exposeFunction("recordUnexpectedCamera", () => { cameraCalls++; });
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { recordUnexpectedCamera: () => Promise<void> };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      await testWindow.recordUnexpectedCamera();
      throw new DOMException("カメラ呼出しを検出しました。", "NotAllowedError");
    } });
  });
  const calls = await mockRequests(page);
  await page.goto("/reception");
  await expect(page.getByRole("heading", { name: "受付端末の登録を確認してください" })).toBeVisible();
  await expect(page.getByRole("link", { name: "この端末を登録する", exact: true })).toHaveAttribute("href", "/device");
  await expect(page.getByRole("button", { name: "カメラを起動", exact: true })).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
  expect({ cameraCalls, records: calls.records, tickets: calls.tickets }).toEqual({ cameraCalls: 0, records: 0, tickets: 0 });
});

test("カメラ許可を拒否すると直し方と明示的な再試行を案内し、自動で再要求しない", async ({ page }) => {
  await mockDevice(page);
  let cameraCalls = 0;
  await page.exposeFunction("recordDeniedCamera", () => { cameraCalls++; });
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { recordDeniedCamera: () => Promise<void> };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      await testWindow.recordDeniedCamera();
      throw new DOMException("利用者が許可を拒否しました。", "NotAllowedError");
    } });
  });
  const calls = await mockRequests(page);
  await startCamera(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("このサイトのカメラ許可を有効にしてください");
  expect(cameraCalls).toBe(1);
  await page.getByRole("button", { name: "カメラを再試行", exact: true }).click();
  await expect.poll(() => cameraCalls).toBe(2);
  await expect(page.getByRole("button", { name: "カメラを再試行", exact: true })).toBeEnabled();
  expect({ records: calls.records, tickets: calls.tickets }).toEqual({ records: 0, tickets: 0 });
});

test("URLのQRを読み取ってもページを開かず、受付要求も記録も送信しない", async ({ page }) => {
  await mockDevice(page);
  const frame = await QRCode.toDataURL("https://example.test/not-an-attendance-qr", { width: 480, margin: 4 });
  await fakeCamera(page, async () => frame);
  const calls = await mockRequests(page);
  let externalRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).hostname === "example.test") externalRequests++; });
  await startCamera(page);
  await expect(page.getByText("このシステムで発行した利用者のQRをかざしてください。読み取ったURLなどは開きません。", { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/reception");
  expect({ externalRequests, records: calls.records, tickets: calls.tickets }).toEqual({ externalRequests: 0, records: 0, tickets: 0 });
});

test("送信失敗後は同じ要求の結果を確認し、未完了なら同じ内容だけを明示再送する", async ({ page }) => {
  await mockDevice(page);
  const frame = await fixedFrame();
  await fakeCamera(page, async () => frame);
  const calls = await mockRequests(page, { mode: "OUT", record: async (route, call) => {
    if (call === 1) await route.abort("failed");
    else await route.fulfill({ json: completed("OUT") });
  } });
  await page.goto("/reception");
  await page.getByRole("button", { name: "退室", exact: true }).click();
  await page.getByRole("button", { name: "カメラを起動", exact: true }).click();
  await expect(page.getByRole("heading", { name: "この受付の結果を確認してください", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "退室を記録しました", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "同じ内容を再送", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "入室", exact: true })).toBeDisabled();
  expect(await storageSummary(page)).toEqual({ onlyRequestId: true, localStorageEmpty: true });
  await page.getByRole("button", { name: "この受付の結果を確認", exact: true }).click();
  await expect(page.getByRole("button", { name: "同じ内容を再送", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "退室を記録しました", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "同じ内容を再送", exact: true }).click();
  await expect(page.getByRole("heading", { name: "退室を記録しました", exact: true })).toBeVisible();
  expect(calls).toEqual({ tickets: 1, records: 2, lookups: 1, correctPayload: true, sameContent: true, correctLookup: true });
  expect(await page.evaluate(() => ({ session: sessionStorage.length, local: localStorage.length }))).toEqual({ session: 0, local: 0 });
});

test("要求IDを保存できない場合は記録を送信せず、保存設定の確認と再開を案内する", async ({ page }) => {
  await mockDevice(page);
  const frame = await fixedFrame();
  await fakeCamera(page, async () => frame);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, "setItem", { configurable: true, value: function (this: Storage, key: string, value: string) {
      if (this === sessionStorage) throw new DOMException("一時保存を拒否しました。", "QuotaExceededError");
      original.call(this, key, value);
    } });
  });
  const calls = await mockRequests(page);
  await startCamera(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("受付の途中状態を保存できなかったため、記録は送信していません");
  await expect(page.getByRole("button", { name: "読み取りを再開", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "入室を記録しました", exact: true })).toHaveCount(0);
  expect({ tickets: calls.tickets, records: calls.records }).toEqual({ tickets: 1, records: 0 });
  expect(await page.evaluate(() => ({ session: sessionStorage.length, local: localStorage.length }))).toEqual({ session: 0, local: 0 });
});

test("再読込では要求IDだけを復元し、失われたQRを再送せず管理者確認のキャンセルを守る", async ({ page }) => {
  await mockDevice(page);
  const frame = await fixedFrame();
  await fakeCamera(page, async () => frame);
  const calls = await mockRequests(page, { record: (route) => route.abort("failed") });
  await startCamera(page);
  await expect(page.getByRole("heading", { name: "この受付の結果を確認してください", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "この受付の結果を確認してください", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "カメラを起動", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "この受付の結果を確認", exact: true }).click();
  await expect(page.getByText(/読み取ったQRは保存していないため、再読込後は再送できません/)).toBeVisible();
  await expect(page.getByRole("button", { name: "同じ内容を再送", exact: true })).toHaveCount(0);
  const reopen = page.getByRole("button", { name: "管理者に確認して受付を再開", exact: true });
  await reopen.click();
  const modal = page.getByRole("dialog", { name: "結果を確認して受付を再開", exact: true });
  await expect(modal.getByRole("button", { name: "キャンセル", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(reopen).toBeFocused();
  expect(await storageSummary(page)).toEqual({ onlyRequestId: true, localStorageEmpty: true });
  expect(calls).toEqual({ tickets: 1, records: 1, lookups: 1, correctPayload: true, sameContent: true, correctLookup: true });
});

test("すでに入室中という業務拒否は成功と区別し、受付モードを勝手に切り替えない", async ({ page }) => {
  await mockDevice(page);
  const frame = await fixedFrame();
  await fakeCamera(page, async () => frame);
  const calls = await mockRequests(page, { record: (route) => route.fulfill({ status: 409, json: {
    ...completed(), outcome: "ALREADY_INSIDE", recordedAt: null, message: "すでに入室中です。退室する場合は退室モードに切り替えてください。",
  } }) });
  await startCamera(page);
  await expect(page.getByRole("heading", { name: "受付できませんでした", exact: true })).toBeVisible();
  await expect(page.getByText("すでに入室中です。退室する場合は退室モードに切り替えてください。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "入室を記録しました", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "入室", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "退室", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect({ records: calls.records, tickets: calls.tickets }).toEqual({ records: 1, tickets: 1 });
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test("HTTP上は業務拒否なのに記録済みという不整合な応答を成功表示しない", async ({ page }) => {
  await mockDevice(page);
  const frame = await fixedFrame();
  await fakeCamera(page, async () => frame);
  const calls = await mockRequests(page, { record: (route) => route.fulfill({ status: 409, json: completed() }) });
  await startCamera(page);
  await expect(page.getByRole("heading", { name: "この受付の結果を確認してください", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "入室を記録しました", exact: true })).toHaveCount(0);
  expect(await storageSummary(page)).toEqual({ onlyRequestId: true, localStorageEmpty: true });
  expect({ records: calls.records, tickets: calls.tickets }).toEqual({ records: 1, tickets: 1 });
});

test("結果照会で別要求の完了応答が届いても成功表示せず元の要求を保持する", async ({ page }) => {
  await mockDevice(page);
  const frame = await fixedFrame();
  await fakeCamera(page, async () => frame);
  const calls = await mockRequests(page, {
    record: (route) => route.abort("failed"),
    lookup: (route) => route.fulfill({ json: { state: "completed", result: { ...completed(), requestId: otherRequestId } } }),
  });
  await startCamera(page);
  await expect(page.getByRole("heading", { name: "この受付の結果を確認してください", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "この受付の結果を確認", exact: true }).click();
  await expect(page.getByText(/この受付の結果を照合できませんでした/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "入室を記録しました", exact: true })).toHaveCount(0);
  expect(await storageSummary(page)).toEqual({ onlyRequestId: true, localStorageEmpty: true });
  expect(calls).toEqual({ tickets: 1, records: 1, lookups: 1, correctPayload: true, sameContent: true, correctLookup: true });
});

test("成功表示が消えて読み取りに戻っても、同じQRをかざしたままでは二重送信しない", async ({ page }) => {
  await mockDevice(page);
  const frame = await fixedFrame();
  let frames = 0;
  await fakeCamera(page, async () => { frames++; return frame; });
  const calls = await mockRequests(page);
  await startCamera(page);
  const success = page.getByRole("heading", { name: "入室を記録しました", exact: true });
  await expect(success).toBeVisible();
  await expect(success).not.toBeVisible();
  // 再開後も複数フレームを実際に流して、単に応答待ちだっただけの成功にしない。
  const before = frames;
  await expect.poll(() => frames).toBeGreaterThan(before + 16);
  expect({ records: calls.records, tickets: calls.tickets, correctPayload: calls.correctPayload }).toEqual({ records: 1, tickets: 1, correctPayload: true });
});
