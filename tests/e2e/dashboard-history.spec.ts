import { test, expect, type Page } from "@playwright/test";
import type { AttendanceDetailResponse, AttendanceHistoryItem, AttendanceHistoryResponse, DashboardResponse, PresenceResponse } from "@mame/contracts";

const personId = "d06645bd-96aa-44cc-bfce-5baa44510cbf";
const secondPersonId = "643506a8-15ba-4aa4-b904-0123278b5982";
const visitId = "479d6a73-0d33-4945-b85c-44c4b8909a6e";
const secondVisitId = "de3e84af-13b0-48b8-a421-f3013680d6dc";
const createdAt = "2026-11-08T03:00:00.000Z";
const currentUserId = "screen-admin";
const person = { id: personId, displayName: "履歴確認の利用者", affiliation: "画面確認の組" };

function visit(overrides: Partial<AttendanceHistoryItem> = {}): AttendanceHistoryItem {
  return { id: visitId, person, enteredAt: "2026-11-07T23:00:00.000Z", exitedAt: null, canceledAt: null, version: 3, source: "RECEPTION", ...overrides };
}

function detail(row: AttendanceHistoryItem): AttendanceDetailResponse {
  const current = { id: row.id, personId: row.person.id, enteredAt: row.enteredAt, exitedAt: row.exitedAt, canceledAt: row.canceledAt, version: row.version };
  return { timeZone: "Asia/Tokyo", asOf: createdAt, visit: { ...row, personId: row.person.id }, nextCursor: null, revisions: [
    { id: "524c2d58-dfbe-4614-a250-f20d9657f870", createdAt: "2026-11-08T02:00:00.000Z", actorName: "確認用の管理者", reason: "確認して入室時刻を補正", before: { ...current, enteredAt: "2026-11-07T23:10:00.000Z", version: current.version - 1 }, after: current },
  ] };
}

async function mockAttendance(page: Page) {
  const currentVisit = visit();
  const state = {
    authorized: true, recentAuth: true, dashboardFailure: false, presenceFailure: false, historyFailure: false, presenceStatus: 200,
    dashboard: { timeZone: "Asia/Tokyo", asOf: createdAt, counts: { inside: 12, needsReview: 2, todayEntered: 4, todayExited: 1 }, recent: [currentVisit] } satisfies DashboardResponse,
    presence: { label: "記録上の在室者", timeZone: "Asia/Tokyo", asOf: createdAt, total: 12, items: [{ id: visitId, person, enteredAt: currentVisit.enteredAt, elapsedSeconds: 14_400, needsReview: false, version: 3 }], nextCursor: null } as PresenceResponse,
    history: { timeZone: "Asia/Tokyo", asOf: createdAt, total: 1, items: [currentVisit], nextCursor: null as string | null },
    detail: detail(currentVisit), dashboardRequests: 0, presenceRequests: [] as URL[], historyRequests: [] as URL[], csvRequests: [] as URL[], detailRequests: 0,
    updates: [] as Array<Record<string, unknown>>, additions: [] as Array<Record<string, unknown>>,
    updateStatus: 200 as number | "abort", addStatus: 201 as number | "abort", csvStatus: 200,
    presenceList: null as ((url: URL) => PresenceResponse) | null,
    historyList: null as ((url: URL) => AttendanceHistoryResponse) | null,
  };
  // 画面の障害対応を架空データで確認し、実DBの認可・排他検査とは分けて扱う。
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "確認用APIの対象外です。" } }));
  await page.route((url) => url.pathname === "/api/appearance", (route) => route.fulfill({ json: {
    displayName: "入退出管理システム", version: 1, iconUrl: "/api/appearance/icon?v=1", faviconUrl: "/api/appearance/favicon?v=1", customIcon: false, customFavicon: false,
  } }));
  await page.route((url) => ["/api/appearance/icon", "/api/appearance/favicon"].includes(url.pathname), (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2D6252"/></svg>' }));
  await page.route("**/api/admin/me", (route) => state.authorized ? route.fulfill({ json: {
    user: { id: currentUserId, name: "確認用の管理者", email: "screen@example.test", emailVerified: false }, database: "connected",
  } }) : route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED", message: "パスキーでログインしてください。" } }));
  await page.route("**/api/admin/security", (route) => route.fulfill({ json: {
    currentUserId, recentAuth: state.recentAuth, recoveryConfigured: true, passkeys: [{ id: "screen-key", name: "確認用パスキー", createdAt, lastUsedAt: null }],
    admins: [{ id: currentUserId, name: "確認用の管理者", email: "screen@example.test", emailVerified: false, status: "ACTIVE" }], adminsNextCursor: null,
  } }));
  await page.route("**/api/admin/facility", (route) => route.fulfill({ json: { id: 1, name: "確認用の施設", timeZone: "Asia/Tokyo" } }));
  await page.route("**/api/admin/dashboard", (route) => {
    state.dashboardRequests++;
    return state.dashboardFailure ? route.abort("connectionreset") : route.fulfill({ json: state.dashboard });
  });
  await page.route((url) => url.pathname === "/api/admin/presence", (route) => {
    const url = new URL(route.request().url()); state.presenceRequests.push(url);
    if (state.presenceStatus !== 200) return route.fulfill({ status: state.presenceStatus, json: { code: "UNAUTHENTICATED", message: "パスキーでログインしてください。" } });
    return state.presenceFailure ? route.abort("connectionreset") : route.fulfill({ json: state.presenceList?.(url) ?? state.presence });
  });
  await page.route((url) => url.pathname === "/api/admin/attendance", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>; state.additions.push(body);
      if (state.addStatus === "abort") return route.abort("connectionreset");
      if (state.addStatus !== 201) return route.fulfill({ status: state.addStatus, json: { code: "INVALID_INTERVAL", message: "入退出の日時を確認してください。" } });
      const saved = visit({ id: secondVisitId, person: { id: secondPersonId, displayName: "もう一人の確認用利用者", affiliation: "別の組" }, enteredAt: body.enteredAt as string, exitedAt: body.exitedAt as string | null, version: 1, source: "MANUAL" });
      state.history.items = [saved, ...state.history.items]; state.history.total++;
      return route.fulfill({ status: 201, json: { id: saved.id, personId: body.personId, enteredAt: saved.enteredAt, exitedAt: saved.exitedAt, canceledAt: null, version: 1 } });
    }
    const url = new URL(route.request().url()); state.historyRequests.push(url);
    return state.historyFailure ? route.abort("connectionreset") : route.fulfill({ json: state.historyList?.(url) ?? state.history });
  });
  await page.route((url) => url.pathname === "/api/admin/attendance.csv", (route) => {
    state.csvRequests.push(new URL(route.request().url()));
    return state.csvStatus === 200 ? route.fulfill({ contentType: "text/csv; charset=utf-8", headers: { "Content-Disposition": 'attachment; filename="attendance.csv"' }, body: "\uFEFF表示名,タイムゾーン\r\n履歴確認の利用者,Asia/Tokyo\r\n" })
      : route.fulfill({ status: state.csvStatus, json: { code: "CSV_LIMIT_EXCEEDED", message: "対象が多いため、期間を絞ってください。" } });
  });
  await page.route((url) => url.pathname === `/api/admin/attendance/${visitId}`, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>; state.updates.push(body);
      if (state.updateStatus === "abort") return route.abort("connectionreset");
      if (state.updateStatus !== 200) return route.fulfill({ status: state.updateStatus, json: { code: "VERSION_CONFLICT", message: "別の操作で記録が変更されています。最新の記録を確認してください。" } });
      const saved = visit({ enteredAt: body.enteredAt as string, exitedAt: body.exitedAt as string | null, canceledAt: body.cancel ? createdAt : null, version: Number(body.expectedVersion) + 1 });
      state.detail = detail(saved); state.history.items = state.history.items.map((row) => row.id === visitId ? saved : row);
      return route.fulfill({ json: { id: saved.id, personId, enteredAt: saved.enteredAt, exitedAt: saved.exitedAt, canceledAt: saved.canceledAt, version: saved.version } });
    }
    state.detailRequests++; return route.fulfill({ json: state.detail });
  });
  await page.route((url) => url.pathname === "/api/admin/people", (route) => route.fulfill({ json: { items: [
    { ...person, phoneticName: null, code: "SCREEN-01", status: "ACTIVE" },
    { id: secondPersonId, displayName: "もう一人の確認用利用者", affiliation: "別の組", phoneticName: null, code: "SCREEN-02", status: "ACTIVE" },
  ], nextCursor: null } }));
  return state;
}

test("未認証ではダッシュボード・在室・履歴を取得せず管理者ログインを案内する", async ({ page }) => {
  const state = await mockAttendance(page); state.authorized = false;
  for (const path of ["/admin", "/presence", "/attendance"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "管理者のログインが必要です", exact: true })).toBeVisible();
    await expect(page.getByText(person.displayName, { exact: true })).toHaveCount(0);
  }
  expect({ dashboard: state.dashboardRequests, presence: state.presenceRequests.length, history: state.historyRequests.length }).toEqual({ dashboard: 0, presence: 0, history: 0 });
});

test("管理ホームの初回取得失敗を0人と表示せず、再試行で実値と履歴への入口を表示する", async ({ page }) => {
  const state = await mockAttendance(page); state.dashboardFailure = true;
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "管理ホーム", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("通信できませんでした");
  await expect(page.getByText(/^0\s*人$/)).toHaveCount(0);
  state.dashboardFailure = false;
  await page.getByRole("button", { name: "最新の情報に更新", exact: true }).click();
  await expect(page.getByText(person.displayName, { exact: true })).toBeVisible();
  const summary = page.getByRole("region", { name: "記録上の在室状況", exact: true });
  await expect(summary.getByRole("link", { name: /記録上の在室者/ })).toContainText("12人");
  await expect(summary.getByRole("link", { name: /要確認/ })).toContainText("2人");
  await expect(page.getByRole("link", { name: "履歴をすべて見る", exact: true })).toHaveAttribute("href", "/attendance");
  expect(state.dashboardRequests).toBeGreaterThanOrEqual(2);
});

test("在室一覧は更新失敗でも最後の情報を保持し、取得時点を確認できる", async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto("/presence");
  await expect(page.getByText(person.displayName, { exact: true })).toBeVisible();
  await expect(page.getByText(/Asia\/Tokyo/).first()).toBeVisible();
  state.presenceFailure = true;
  await page.getByRole("button", { name: "最新の情報に更新", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("通信できませんでした");
  await expect(page.getByText(person.displayName, { exact: true })).toBeVisible();
  await expect(page.getByText(/^0\s*人$/)).toHaveCount(0);
});

test("在室の検索と要確認条件をページ継続に引き継ぎ、新しい検索ではカーソルを戻す", async ({ page }) => {
  const state = await mockAttendance(page);
  state.presenceList = (url) => ({ ...state.presence, items: url.searchParams.has("cursor") ? [{ ...state.presence.items[0]!, id: secondVisitId, person: { id: secondPersonId, displayName: "要確認の二人目", affiliation: "検索対象" }, needsReview: true }]
    : [{ ...state.presence.items[0]!, person: { ...person, affiliation: "検索対象" }, enteredAt: "2026-11-07T03:00:00.000Z", elapsedSeconds: 86_400, needsReview: true }],
    nextCursor: url.searchParams.has("cursor") ? null : visitId });
  await page.goto("/presence");
  await page.getByLabel("名前・所属で検索", { exact: true }).fill("検索対象");
  await page.getByLabel("要確認の人だけ", { exact: true }).check();
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect.poll(() => state.presenceRequests.at(-1)?.searchParams.get("q")).toBe("検索対象");
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await expect(page.getByText("要確認の二人目", { exact: true })).toBeVisible();
  const continuation = state.presenceRequests.at(-1)!;
  expect({ q: continuation.searchParams.get("q"), review: continuation.searchParams.get("review"), cursor: continuation.searchParams.get("cursor") }).toEqual({ q: "検索対象", review: "true", cursor: visitId });
  await page.getByLabel("名前・所属で検索", { exact: true }).fill("別の検索");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect.poll(() => state.presenceRequests.at(-1)?.searchParams.get("q")).toBe("別の検索");
  expect(state.presenceRequests.at(-1)!.searchParams.has("cursor")).toBe(false);
});

test("在室の再取得で認証が失効した場合は通信断と区別し、表示済みの個人情報を残さない", async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto("/presence");
  await expect(page.getByText(person.displayName, { exact: true })).toBeVisible();
  state.presenceStatus = 401;
  await page.getByRole("button", { name: "最新の情報に更新", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("ログインしてください");
  await expect(page.getByText(person.displayName, { exact: true })).toHaveCount(0);
});

test("履歴のCSVは適用済みの検索条件を使用し、編集中の条件を混ぜない", async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto("/attendance");
  await page.getByLabel("開始日", { exact: true }).fill("2026-11-01");
  await page.getByLabel("終了日", { exact: true }).fill("2026-11-08");
  await page.getByLabel("名前・所属で検索", { exact: true }).fill("画面確認");
  await page.getByLabel("状態", { exact: true }).selectOption("completed");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect.poll(() => state.historyRequests.at(-1)?.searchParams.get("q")).toBe("画面確認");
  await page.getByLabel("名前・所属で検索", { exact: true }).fill("まだ検索していない条件");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSVをダウンロード", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "CSVをダウンロード", exact: true });
  await expect(modal).toContainText("画面確認");
  await expect(modal).not.toContainText("まだ検索していない条件");
  await modal.getByRole("button", { name: "CSVをダウンロード", exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("入退室履歴.csv");
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const content = Buffer.concat(chunks);
  expect([...content.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(content.toString("utf8")).toContain("履歴確認の利用者,Asia/Tokyo");
  const query = state.csvRequests.at(-1)!;
  expect({ q: query.searchParams.get("q"), from: query.searchParams.get("from"), to: query.searchParams.get("to"), status: query.searchParams.get("status"), cursor: query.searchParams.get("cursor") })
    .toEqual({ q: "画面確認", from: "2026-11-01", to: "2026-11-08", status: "completed", cursor: null });
});

test("CSVの上限エラーではダウンロード成功とせず期間の絞り込みを案内する", async ({ page }) => {
  const state = await mockAttendance(page); state.csvStatus = 422;
  const downloads: string[] = []; page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.goto("/attendance");
  await expect(page.getByText(person.displayName, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "CSVをダウンロード", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "CSVをダウンロード", exact: true });
  await modal.getByRole("button", { name: "CSVをダウンロード", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("期間を絞ってください");
  expect(downloads).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByText(person.displayName, { exact: true })).toBeVisible();
});

test("履歴の詳細で変更理由を確認でき、閉じると操作した記録へフォーカスが戻る", async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto("/attendance");
  await expect(page.getByText(person.displayName, { exact: true })).toBeVisible();
  const open = page.getByRole("button", { name: /^詳細・訂正/ }).first();
  await open.click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("確認して入室時刻を補正");
  await expect(modal.getByRole("button", { name: "時刻を訂正", exact: true })).toBeVisible();
  await expect(modal.getByRole("button", { name: "記録を取り消す", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(open).toBeFocused();
  expect({ details: state.detailRequests, updates: state.updates.length }).toEqual({ details: 1, updates: 0 });
});

test("訂正の版競合は入力を保持して再送を止め、最新の記録を読み直せる", async ({ page }) => {
  const state = await mockAttendance(page); state.updateStatus = 409;
  await page.goto("/attendance");
  await page.getByRole("button", { name: /^詳細・訂正/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "時刻を訂正", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "入退室時刻を訂正", exact: true });
  await modal.getByLabel("入室日時", { exact: true }).fill("2026-11-08T08:30");
  await modal.getByLabel("変更理由", { exact: true }).fill("確認した時刻へ訂正します");
  await modal.getByRole("button", { name: "訂正を保存", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("別の操作で記録が変更");
  await expect(modal.getByLabel("入室日時", { exact: true })).toHaveValue("2026-11-08T08:30");
  await expect(modal.getByLabel("変更理由", { exact: true })).toHaveValue("確認した時刻へ訂正します");
  await expect(modal.getByRole("button", { name: "訂正を保存", exact: true })).toBeDisabled();
  expect(state.updates).toHaveLength(1);
  expect(state.updates[0]).toMatchObject({ expectedVersion: 3, enteredAt: "2026-11-07T23:30:00.000Z", exitedAt: null, cancel: false, reason: "確認した時刻へ訂正します" });
  state.detail = detail(visit({ version: 4, exitedAt: "2026-11-08T02:00:00.000Z" }));
  await modal.getByRole("button", { name: "最新の記録を読み直す", exact: true }).click();
  const current = page.getByRole("dialog", { name: "記録の詳細・変更履歴", exact: true });
  await expect(current).toContainText("退室済み");
  expect(state.detailRequests).toBe(2);
});

test("記録取消は対象と影響を確認でき、キャンセルでは送信せず理由付きで実行する", async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto("/attendance");
  const open = page.getByRole("button", { name: /^詳細・訂正/ }).first();
  await open.click();
  await page.getByRole("dialog").getByRole("button", { name: "記録を取り消す", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "記録を取り消す", exact: true });
  await expect(modal).toContainText("在室状況と通常の集計から除外");
  await expect(modal).toContainText(person.displayName);
  await expect(modal.getByLabel("変更理由", { exact: true })).toBeFocused();
  await modal.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(open).toBeFocused();
  expect(state.updates).toHaveLength(0);
  await open.click();
  await page.getByRole("dialog").getByRole("button", { name: "記録を取り消す", exact: true }).click();
  await modal.getByLabel("変更理由", { exact: true }).fill("誤って記録されたため取消");
  await modal.getByRole("button", { name: "この記録を取り消す", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByRole("status")).toContainText("記録を取り消しました");
  expect(state.updates).toHaveLength(1);
  expect(state.updates[0]).toMatchObject({ expectedVersion: 3, enteredAt: "2026-11-07T23:00:00.000Z", exitedAt: null, cancel: true, reason: "誤って記録されたため取消" });
});

test("手動追加は利用者を選び、施設の日時と理由・要求IDを送信する", async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto("/attendance");
  await page.getByRole("button", { name: "手動で記録を追加", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "手動で記録を追加", exact: true });
  await modal.getByLabel("利用者を名前・所属で探す", { exact: true }).fill("もう一人");
  await modal.getByRole("button", { name: "利用者を検索", exact: true }).click();
  const select = modal.getByRole("button", { name: /^もう一人の確認用利用者/ });
  await select.click();
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await modal.getByLabel("入室日時", { exact: true }).fill("2026-11-08T08:30");
  await modal.getByLabel(/^退室日時/).fill("2026-11-08T09:10");
  await modal.getByLabel("変更理由", { exact: true }).fill("受付で確認したため手動で追加");
  await modal.getByRole("button", { name: "記録を追加", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByRole("status")).toContainText("記録を追加しました");
  expect(state.additions).toHaveLength(1);
  expect(state.additions[0]).toMatchObject({ personId: secondPersonId, enteredAt: "2026-11-07T23:30:00.000Z", exitedAt: "2026-11-08T00:10:00.000Z", reason: "受付で確認したため手動で追加" });
  expect(state.additions[0]!.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
});

test("手動追加の通信断は保存成功とせず入力を保持し、履歴確認まで追加の再送を止める", async ({ page }) => {
  const state = await mockAttendance(page); state.addStatus = "abort";
  await page.goto("/attendance");
  const open = page.getByRole("button", { name: "手動で記録を追加", exact: true });
  await open.click();
  const modal = page.getByRole("dialog", { name: "手動で記録を追加", exact: true });
  await modal.getByRole("button", { name: "利用者を検索", exact: true }).click();
  await modal.getByRole("button", { name: /^もう一人の確認用利用者/ }).click();
  await modal.getByLabel("入室日時", { exact: true }).fill("2026-11-08T08:30");
  await modal.getByLabel("変更理由", { exact: true }).fill("通信断の確認用の記録");
  await modal.getByRole("button", { name: "記録を追加", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("保存結果を確認できません");
  await expect(modal.getByLabel("変更理由", { exact: true })).toHaveValue("通信断の確認用の記録");
  await expect(modal.getByRole("button", { name: "記録を追加", exact: true })).toBeDisabled();
  await expect(page.getByText("記録を追加しました。", { exact: true })).toHaveCount(0);
  expect(state.additions).toHaveLength(1);
  await modal.getByRole("button", { name: "閉じて履歴を確認", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(open).toBeFocused();
  expect(state.additions).toHaveLength(1);
});

test("古い本人確認でパスキーをキャンセルした場合、記録訂正を送信しない", async ({ page }) => {
  const state = await mockAttendance(page); state.recentAuth = false;
  let prompts = 0;
  await page.exposeFunction("countHistoryPasskeyPrompt", () => { prompts++; });
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { countHistoryPasskeyPrompt: () => Promise<void> };
    Object.defineProperty(navigator.credentials, "get", { configurable: true, value: async () => {
      await testWindow.countHistoryPasskeyPrompt(); throw new DOMException("本人確認をキャンセルしました。", "NotAllowedError");
    } });
  });
  await page.route("**/api/auth/passkey/generate-authenticate-options*", (route) => route.fulfill({ json: { challenge: "AQIDBA", rpId: new URL(route.request().url()).hostname, userVerification: "required", allowCredentials: [] } }));
  await page.goto("/attendance");
  await page.getByRole("button", { name: /^詳細・訂正/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "時刻を訂正", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "入退室時刻を訂正", exact: true });
  await modal.getByLabel("変更理由", { exact: true }).fill("本人確認を中止するテスト");
  await expect(modal.getByRole("button", { name: "訂正を保存", exact: true })).toBeDisabled();
  await modal.getByRole("button", { name: "パスキーで本人確認", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("本人確認");
  expect(prompts).toBe(1);
  expect(state.updates).toHaveLength(0);
  await expect(modal.getByLabel("変更理由", { exact: true })).toHaveValue("本人確認を中止するテスト");
});
