import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";
export default defineConfig({ cacheDir: join(tmpdir(), "mame-inout-vitest"), test: { fsModuleCache: false, include: ["tests/integration/**/*.test.ts"], testTimeout: 15000, fileParallelism: false } });
