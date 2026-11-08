# 開発者向けガイド

このガイドは、ソースコードを変更して動作を確かめる方向けです。施設へ設置して使う場合は[サーバーへの導入](install.md)、日々の操作は[画面の使い方](usage.md)を参照してください。使用技術と想定サーバーの概要は[README](../README.md)、テーブルの関係と制約は[DB設計ガイド](database.md)にまとめています。

## ディレクトリ構造

```text
.
├── apps/
│   ├── web/
│   │   ├── app/                 Next.jsのページ、共通画面部品、CSS
│   │   └── public/              アイコンと第三者ライセンス表示
│   └── api/
│       ├── src/                 Honoの認証・認可・業務処理
│       └── prisma/
│           ├── schema.prisma    ORMのモデル定義
│           └── migrations/      DBへ適用するSQLと制約
├── packages/contracts/src/      画面とAPIで共有する型・Zodスキーマ
├── infra/                       Dockerfile、プロキシ、DB初期化設定
├── scripts/                     開発準備、配布、保守、性能確認
├── tests/
│   ├── integration/             実PostgreSQLを使う結合テスト
│   ├── e2e/                     Playwrightによるブラウザ操作
│   └── performance/             条件を固定した負荷確認と実行ガード
├── .github/workflows/           GitHub Actions
├── compose*.yaml                実行環境ごとのCompose設定
├── package.json                 ワークスペースと共通コマンド
└── package-lock.json            依存パッケージの固定値
```

DBを使わない処理のテストは、対象コードの近くにもあります。API側は `apps/api/src/*.test.ts`、表示用の処理は `apps/web/app/ui/*.test.ts` です。

## 各部分の責任

ブラウザは同じOriginの画面と `/api/` を使います。プロキシが画面をNext.js、APIをHonoへ振り分けます。

| 場所 | 変更するときに確認すること |
| --- | --- |
| [apps/web/app](../apps/web/app) | 表示、入力、カメラ、モーダル、処理中・完了・失敗の案内。サーバーの成功応答前に受付完了を表示しない |
| [apps/api/src](../apps/api/src) | 認証、毎回の認可、入退室ルール、DBのトランザクション。ブラウザ側の制御だけを権限の根拠にしない |
| [packages/contracts/src](../packages/contracts/src) | 入出力の型と実行時検証。画面・API・テストを同じ変更に追従させる |
| [schema.prisma](../apps/api/prisma/schema.prisma)・[migrations](../apps/api/prisma/migrations) | モデルとSQLの両方を確認する。部分一意制約、排他制約、権限などはSQLにも定義されている |
| [infra](../infra)・[compose.yaml](../compose.yaml) | コンテナの接続、公開ポート、秘密ファイルの受け渡し。Next.jsへDB資格情報を渡さない |
| [scripts](../scripts) | セットアップ、固定配布物、バックアップ・復元・削除台帳などの保守処理 |

APIを変更する場合は、共有スキーマ、Honoの処理、DB制約、結合テスト、画面の案内を一緒に確認してください。DB移行は [migrate.ts](../apps/api/src/migrate.ts) がSQLのチェックサムを記録して適用します。適用済みSQLの編集や `prisma db push` での置き換えは行わず、新しい移行を追加します。

## 開発に必要なもの

- Node.js 24系。リポジトリの [.node-version](../.node-version) は `24.22.2` を指定しています。
- npm `11.19.1`。依存関係は `package-lock.json` に合わせ、`npm ci` で準備します。
- Docker EngineとDocker Composeプラグイン。WindowsではLinuxコンテナを使うDocker Desktopが必要です。
- 保守処理のテストも行う場合はPython 3とGnuPG。性能確認は専用環境を使います。

以下のシェル例はリポジトリのルートで実行します。本番DB、実利用者の情報、本番用の秘密ファイルは使用しません。ポート・Composeプロジェクト名・秘密フォルダーが、既存環境と重なっていないことを確認してください。

## 型・Lint・基本テスト

この段階では、実DBを起動する必要はありません。Prisma Clientと共有パッケージを先に生成します。

```sh
npm ci --no-audit --no-fund
npm run generate
npm run build -w @mame/contracts
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` は[基本テストの設定](../vitest.config.ts)に従います。`npm run build` は共有パッケージ、API、画面の順にビルドします。

## 独立した開発・テスト環境を起動する

この例は架空データだけを使う環境です。結合テストは認証データの初期化も行うため、日常の受付や手動確認で残したいデータとは分けます。

### Linuxのシェル

この例は、開発ユーザーのUIDが `1000` で、そのユーザーがDockerを操作できる環境を前提にしています。`id -u` でUIDを確認してください。コンテナ内の実行UIDも `1000` のため、生成後の秘密フォルダーをその所有者へ合わせます。UIDが異なる場合は、この条件に合う専用の開発環境を用意してください。既存ユーザーのUIDや他サービスのデータ所有者を変更して合わせないでください。

```sh
export COMPOSE_PROJECT_NAME=mame-inout-test-dev
export APP_ORIGIN=http://localhost:8081
export HTTP_PORT=8081
export SECRETS_DIR=./secrets/dev-guide
export API_IMAGE=mame-inout-api:dev-guide
export WEB_IMAGE=mame-inout-web:dev-guide

node scripts/setup-dev.mjs ./secrets/dev-guide
sudo chown -R 1000:1000 ./secrets/dev-guide

dc() {
  docker compose -p "$COMPOSE_PROJECT_NAME" -f compose.yaml -f compose.test.yaml "$@"
}

dc build api web tests
dc up -d --wait api web proxy
dc ps
```

秘密ファイルは生成した開発用フォルダーだけをUID/GID `1000:1000`へ渡します。APIとDBはそのUIDで実行され、秘密ファイルの権限も検査します。読み取りエラーを回避するために、ファイルを全員が読める権限へ変更しないでください。

### WindowsのPowerShell

Windowsでは、ファイル型secretsをそのままLinuxの権限値と扱わず、[Composeの追加設定](../compose.desktop.yaml)で専用volumeへ写します。テストには[テスト用追加設定](../compose.test.desktop.yaml)も使います。

```powershell
$env:COMPOSE_PROJECT_NAME = 'mame-inout-test-dev'
$env:APP_ORIGIN = 'http://localhost:8081'
$env:HTTP_PORT = '8081'
$env:SECRETS_DIR = './secrets/dev-guide'
$env:API_IMAGE = 'mame-inout-api:dev-guide'
$env:WEB_IMAGE = 'mame-inout-web:dev-guide'

node scripts/setup-dev.mjs ./secrets/dev-guide

function dc {
  docker compose -p $env:COMPOSE_PROJECT_NAME -f compose.yaml -f compose.desktop.yaml -f compose.test.yaml -f compose.test.desktop.yaml @args
}

dc build api web tests
dc up -d --wait api web proxy
dc ps
```

以降の `dc` は、同じシェルで定義した関数を使います。画面は `http://localhost:8081` です。スマホ実機では `localhost` が開発PCを指さないため、同じURLを使えません。スマホでのパスキー・カメラ確認には、端末が信頼するHTTPSの公開URLを別途用意します。

### 手動で画面を確かめる場合

自分のパスキーや架空データを残して確認する場合は、別の手動確認用環境を作ります。例えばプロジェクト名を `mame-inout-dev-manual`、秘密フォルダーを `./secrets/dev-manual`、Originとポートを `http://localhost:8082` / `8082` にそろえ、同じ起動手順を使います。この環境ではDBを初期化する結合テストや、初期登録から始まるE2Eを実行しません。

初期設定コードをAPIコンテナ内の新規ファイルへ発行し、ログや画面共有に残らない安全な端末で確認します。[導入手順](install.md)と[最初の管理者を登録する手順](usage.md)に従って登録し、コードのファイルは使用後に削除してください。

### コード変更を反映する

上のCompose設定は、ソースを監視して自動更新する構成ではありません。変更後はイメージを再ビルドしてサービスを更新します。

```sh
dc build api web tests
dc up -d --wait api web proxy
```

通常の更新ではDBのvolumeを残します。SQL移行は起動時の `migrate` サービスが適用し、失敗すればAPIの起動を止めます。ホストで各[開発起動スクリプト](../apps/api/package.json)を使う場合も、プロキシ、Origin、秘密ファイル、DB接続を別途合わせる必要があります。Hono用のDB資格情報をNext.jsへ渡さないでください。

## 実PostgreSQLの結合テスト

上で用意した専用環境で実行します。

```sh
dc run --rm tests
```

[compose.test.yaml](../compose.test.yaml)は `TEST_PROJECT` を渡します。テストは `mame-inout-test` または `mame-inout-test-` で始まるプロジェクト名を要求しますが、名前の確認だけで本番DBとの分離を保証するものではありません。秘密フォルダー、DBのvolume、ポートも専用にしてください。

結合テストは実DBへ書き込み、認証テーブルなどを初期化します。E2Eで登録済みの管理者や、保存したい架空データがあるDBへ実行しないでください。

## PlaywrightのE2E

E2Eは、仮想認証器による初期管理者の登録から始める検査と、架空のAPI応答による画面検査を含みます。最初の管理者をまだ登録していない専用DBで実行してください。結合テストも行う場合は、結合テストを先に実行します。

先にブラウザを準備します。Linuxの `--with-deps` はブラウザのOS依存パッケージも導入します。

```sh
npx playwright install --with-deps chromium
```

まず、API内の新規ファイルへ初期設定コードを発行します。

```sh
dc exec -T api node dist/setup-code.js /tmp/e2e-setup-code
```

コードの有効期限は15分です。同名ファイルの上書きと、初期設定完了後の発行は拒否します。続いて、[docker compose cp](https://docs.docker.com/reference/cli/docker/compose/cp/)でコードを標準出力へ表示せず、テスト用入力ファイルとして受け渡します。

Linuxでは次を実行します。

```sh
umask 077
mkdir -p ./secrets/dev-guide-input
dc cp api:/tmp/e2e-setup-code ./secrets/dev-guide-input/e2e-setup-code
chmod 600 ./secrets/dev-guide-input/e2e-setup-code
export E2E_SETUP_CODE_FILE=./secrets/dev-guide-input/e2e-setup-code
export E2E_ORIGIN=http://localhost:8081
test -r "$E2E_SETUP_CODE_FILE"
```

PowerShellでは、入力用フォルダーのアクセス権も生成スクリプトで限定します。このフォルダー内に生成されるDB用ファイルは、ここでは使用しません。

```powershell
node scripts/setup-dev.mjs ./secrets/dev-guide-input
dc cp api:/tmp/e2e-setup-code ./secrets/dev-guide-input/e2e-setup-code
$env:E2E_SETUP_CODE_FILE = './secrets/dev-guide-input/e2e-setup-code'
$env:E2E_ORIGIN = 'http://localhost:8081'
$null = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $env:E2E_SETUP_CODE_FILE).Path)
```

Linuxの `test -r` が成功すること、PowerShellの読取確認で例外が出ないことを確認してから進みます。内容は表示しません。コピー先はホストでテストを実行するユーザーが読み取れる必要があります。権限エラーの場合は、コピー先の所有者とアクセス権を確認し、他のユーザーに公開する設定では回避しないでください。

同じシェルでテストを実行します。

```sh
npm run test:e2e
```

実行後はホストのテスト入力ファイルと、API内の `/tmp/e2e-setup-code` を削除してください。`secrets/` はGitとDockerのビルド対象から除外されていますが、除外だけを秘密情報の保護策とせず、ファイル権限と保管期間も管理します。

実際のパスキーやカメラの動作は、仮想認証器とテスト用映像だけでは確認できません。変更した機能に応じて、iPhoneのSafariとAndroidのChromeでも確認してください。[Playwright設定](../playwright.config.ts)では、認証情報を成果物へ含めないようにtrace・自動スクリーンショット・動画を無効にしています。認証テストの記録機能を一括で有効にせず、追加する場合は秘密値が残らないことを確認します。

### 再実行と停止

初期登録を完了したDBでは、初期登録から始めるE2Eをそのまま繰り返せません。残したいデータがある場合は、別のプロジェクト名・秘密フォルダー・ポートで新しい環境を作ります。

専用環境を停止するだけなら、DBを残します。

```sh
dc stop api web proxy db
```

DBから作り直す場合の `dc down --volumes` は、そのプロジェクトのコンテナ・ネットワーク・DB volumeと、Windows用の秘密volumeを削除します。プロジェクト名と `dc ps -a` の対象が、この使い捨て開発環境だけであることを確認してから実行してください。Docker全体のpruneや、他サービスのvolume削除は行いません。

## 変更前後に確認すること

| 変更 | 主に確認する範囲 |
| --- | --- |
| 業務ルール・認可・DB | 基本テスト、実DB結合、関連するE2E。二重送信・同時操作・失効・訂正も含める |
| 画面・共通モーダル | 型・Lint・ビルド、画面E2E、スマホ幅、キーボード、フォーカス・読み上げ |
| パスキー・QRカメラ | 自動検査に加えて実機。キャンセル、許可拒否、通信断後の再試行も確認する |
| 保守処理 | `python3 -B tests/operations_test.py`。暗号化・外部保管・削除台帳・復元を実環境でも確認する |
| 性能確認 | [性能検査のガード](../tests/performance/m07-guards.test.mjs)と[実行スクリプト](../scripts/benchmark-m07.mjs)を読む。対象環境・人数・記録数・並列数を固定して結果を記録する |

確認ダイアログは共通のアプリ内モーダルを使います。パスキーやカメラ許可のOS・ブラウザ標準ダイアログは、その仕組みに従います。コミット前には差分と追加ファイルを読み、デバッグ用の `console.log`、実データ、秘密値が含まれていないことを確認してください。

[GitHub Actions](../.github/workflows/ci.yml)は、`main`向けPull Requestと、`main`への取り込み後に実行します。`develop`へのpushだけでは同じCIを重複実行しません。実行結果は対象のコミットと対応させ、[確認済みの範囲](overview.md#確認できている範囲)の説明も更新してください。
