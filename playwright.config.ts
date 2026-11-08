import { defineConfig, devices } from "@playwright/test";

// 一度表示した復旧コード等を、失敗時に自動作成されるARIAの画面記録へ残さない。
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "tests/e2e", workers: 1, retries: 0, timeout: 45000,
  use: {
    baseURL: process.env.E2E_ORIGIN ?? "http://localhost:8081",
    // 認証コード・Cookie・チャレンジを成果物に含めない。
    trace: "off", screenshot: "off", video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
