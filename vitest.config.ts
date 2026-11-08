import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["apps/api/src/**/*.test.ts", "apps/web/app/ui/**/*.test.ts"], testTimeout: 15000 } });
