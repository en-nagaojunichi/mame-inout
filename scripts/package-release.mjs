import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version)) throw new Error("配布版の形式が不正です。");
const destination = resolve(process.argv[2] ?? `dist/${version}`);
const inputApi = process.argv[3];
const inputWeb = process.argv[4];
if (!inputApi || !inputWeb || !destination.startsWith(root + "\\") && !destination.startsWith(root + "/")) {
  throw new Error("保存先と、検証済みAPI/Webイメージの参照を指定してください。");
}
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
// Gitの除外結果に加えて配布範囲を固定し、実データやビルド出力を拾わない。
const roots = new Set(["apps", "packages", "infra", "scripts", "tests", "docs", ".github"]);
const rootFiles = new Set(["package.json", "package-lock.json", "tsconfig.base.json", "eslint.config.mjs", "vitest.config.ts", "vitest.integration.config.ts", "playwright.config.ts", ".npmrc", ".node-version", ".gitattributes", ".gitignore", ".dockerignore", ".env.example", "compose.yaml", "compose.https.yaml", "compose.nginx.yaml", "compose.desktop.yaml", "compose.test.yaml", "compose.test.desktop.yaml", "README.md", "LICENSE"]);
await mkdir(destination, { recursive: false });
const hashes = {};
for (const file of [...new Set(files)].sort()) {
  const parts = file.split("/");
  if (!roots.has(parts[0]) && !rootFiles.has(file)) continue;
  if (parts.some((part) => ["node_modules", ".next", "dist", "generated", "__pycache__"].includes(part)) || /\.(?:pyc|log|tsbuildinfo)$/.test(file)) continue;
  if (parts.some((part) => part.startsWith(".env") && part !== ".env.example")) throw new Error("配布対象に環境設定が含まれています。");
  const source = resolve(root, file);
  if (!(await lstat(source)).isFile()) throw new Error("通常ファイルだけを配布できます。");
  const target = resolve(destination, "source", file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  hashes[file] = createHash("sha256").update(await readFile(source)).digest("hex");
}
const references = { api: inputApi, web: inputWeb, postgres: "postgres:18.6-bookworm", proxy: "caddy:2.11.9-alpine" };
const images = {};
for (const [name, reference] of Object.entries(references)) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]+$/.test(reference) || reference.endsWith(":latest") || reference.endsWith(":dev")) throw new Error("検証した固定のイメージ参照が必要です。");
  const image = JSON.parse(execFileSync("docker", ["image", "inspect", reference], { encoding: "utf8" }))[0];
  images[name] = { reference, id: image.Id };
}
execFileSync("docker", ["image", "save", "--output", join(destination, "images.tar"), ...Object.values(references)], { stdio: "inherit" });
const archiveHash = createHash("sha256");
for await (const chunk of createReadStream(join(destination, "images.tar"))) archiveHash.update(chunk);
await writeFile(join(destination, "manifest.json"), JSON.stringify({ format: 1, version, files: hashes, images, imagesSha256: archiveHash.digest("hex") }, null, 2));
console.info(`固定配布物を作成しました: ${relative(root, destination)}`);
