import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/dist/**", "**/.next/**", "**/generated/**", "**/next-env.d.ts"]),
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    // 調査用の出力を残して公開しない。運用上の警告・障害だけを明示して出力する。
    rules: { "no-console": ["error", { allow: ["info", "warn", "error"] }] },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs["core-web-vitals"].rules, ...reactHooks.configs.recommended.rules },
    settings: { next: { rootDir: "apps/web" } },
  },
]);
