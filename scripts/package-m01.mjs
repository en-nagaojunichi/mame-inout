import { mkdir, readdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const version = process.argv[2] ?? "m01-20261107.1";
if (!/^m01-\d{8}\.\d+$/.test(version)) throw new Error("検証用バージョンの形式が不正です。");
const target = resolve("dist", version);
await mkdir(resolve("dist"), { recursive: true });
await mkdir(target, { recursive: false });
const source = join(target, "source");
await mkdir(source);
const hashes = {};
const omitted = new Set(["node_modules", ".next", "dist", "generated"]);
async function copy(path) {
  const full = join(root, path);
  const entries = await readdir(full, { withFileTypes: true });
  for (const entry of entries) {
    if (omitted.has(entry.name) || entry.name.startsWith(".env") && entry.name !== ".env.example" || /\.(log|tsbuildinfo)$/.test(entry.name)) continue;
    const next = join(path, entry.name);
    if (entry.isDirectory()) await copy(next);
    else if (entry.isFile()) await copyOne(next);
  }
}
async function copyOne(path) {
  const input = join(root, path);
  const output = join(source, path);
  await mkdir(resolve(output, ".."), { recursive: true });
  await copyFile(input, output);
  hashes[path.replaceAll("\\", "/")] = createHash("sha256").update(await readFile(input)).digest("hex");
}
// 配布範囲を明示し、開発環境の設定や実データを収集しない。
for (const dir of ["apps", "packages", "infra", "scripts", "tests", "docs", ".github"]) await copy(dir);
for (const file of ["package.json", "package-lock.json", "tsconfig.base.json", "eslint.config.mjs", "vitest.config.ts", "vitest.integration.config.ts", "playwright.config.ts", ".npmrc", ".node-version", ".gitattributes", ".gitignore", ".dockerignore", ".env.example", "compose.yaml", "compose.https.yaml", "compose.nginx.yaml", "compose.desktop.yaml", "compose.test.yaml", "compose.test.desktop.yaml", "README.md", "LICENSE"]) await copyOne(file);
const images = ["mame-inout-api", "mame-inout-web"];
for (const name of images) execFileSync("docker", ["tag", `${name}:dev`, `${name}:${version}`]);
const references = [...images.map((name) => `${name}:${version}`), "postgres:18.6-bookworm", "caddy:2.11.9-alpine"];
execFileSync("docker", ["image", "save", "--output", join(target, "images.tar"), ...references], { stdio: "inherit" });
const identities = JSON.parse(execFileSync("docker", ["image", "inspect", ...references], { encoding: "utf8" })).map((entry) => ({ id: entry.Id, tags: entry.RepoTags, digests: entry.RepoDigests }));
const ordered = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(join(target, "manifest.json"), JSON.stringify({ version, status: "M01検証用・未リリース・未コミット", sourceTreeSha256: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"), images: identities, files: ordered }, null, 2));
await writeFile(join(target, "README.txt"), `M01認証検証用。正式リリースではありません。\nimages.tarをdocker loadで読み込み、sourceのComposeを使用します。\nAPI_IMAGE=mame-inout-api:${version}\nWEB_IMAGE=mame-inout-web:${version}\n秘密ファイルは設置先で別途生成します。既存のHTTPSサーバーがある場合はcompose.nginx.yamlとinfra/nginx.conf.exampleを確認し、同じ公開ポートを重複して使用しないでください。\n画面の操作方法はsource/docs/usage.mdを確認してください。\n`);
console.info(`検証用成果物を作成しました: ${relative(root, target)}`);
