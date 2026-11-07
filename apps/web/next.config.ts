import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(process.cwd(), "../.."),
  poweredByHeader: false,
  transpilePackages: ["@mame/contracts"],
};
export default config;
