import type { NextConfig } from "next";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// 配付時の版を一か所から表示し、画面ごとの書き換え漏れを防ぐ。秘密値は取り込まない。
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "../../package.json"), "utf8")) as { version: string };

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(process.cwd(), "../.."),
  poweredByHeader: false,
  transpilePackages: ["@mame/contracts"],
  env: { NEXT_PUBLIC_APP_VERSION: manifest.version },
};
export default config;
