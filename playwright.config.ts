import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e", workers: 1, retries: 0, timeout: 45000,
  use: {
    baseURL: process.env.E2E_ORIGIN ?? "http://localhost:8081",
    // 認証コード・Cookie・チャレンジを成果物に含めない。
    trace: "off", screenshot: "off", video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
