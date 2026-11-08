# ライセンスと画像・書体

入退出管理システム本体は[MITライセンス](../LICENSE)です。第三者のライブラリには、それぞれのライセンスが適用されます。再配布する場合も、著作権表示とライセンス本文を保持してください。

## 主なライブラリ

以下は、画面・認証・API・DB接続・QR機能で直接使用するライブラリです。バージョンは同梱の`package-lock.json`に固定しています。

| ライブラリ | バージョン | ライセンス |
| --- | --- | --- |
| [React / React DOM](https://github.com/facebook/react) | 19.3.1 | MIT |
| [Next.js](https://github.com/vercel/next.js) | 16.4.5 | MIT |
| [Hono](https://github.com/honojs/hono) | 4.13.16 | MIT |
| [@hono/node-server](https://github.com/honojs/node-server) | 2.1.6 | MIT |
| [Better Auth / @better-auth/passkey / @better-auth/prisma-adapter](https://github.com/better-auth/better-auth) | 1.7.18 | MIT |
| [Prisma / @prisma/client / @prisma/adapter-pg](https://github.com/prisma/prisma) | 7.10.1 | Apache License 2.0 |
| [pg](https://github.com/brianc/node-postgres) | 8.23.1 | MIT |
| [Zod](https://github.com/colinhacks/zod) | 4.6.7 | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | [MIT](../apps/web/public/licenses/qrcode-LICENSE.txt) |
| [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | [Apache License 2.0](../apps/web/public/licenses/jsqr-LICENSE.txt) |

上記15パッケージの配布物に含まれる原文を[第三者ライブラリのライセンス本文](../apps/web/public/licenses/third-party-notices.txt)にまとめています。稼働中のサイトでも、`/licenses/NOTICE.txt`、`/licenses/third-party-notices.txt`、`/licenses/qrcode-LICENSE.txt`、`/licenses/jsqr-LICENSE.txt`から確認できます。

これらはすべての推移依存を列挙した一覧ではありません。その他の依存や、Next.jsに同梱された第三者コードには、各配布物に含まれるライセンスが適用されます。Node.js・PostgreSQL・Caddyとコンテナ内のOSパッケージについても、各配布物のライセンス・著作権表示を保持してください。

## 書体とアイコン

文字は端末にインストールされている書体で表示します。CSSではNoto Sans JP、ヒラギノ角ゴシック、游ゴシック、システム標準のゴシック体の順に指定しています。Webフォントのファイルや外部フォント配信サービスは使用していません。

既定のシステムアイコン・ファビコンとメニューのアイコンは、このソフトウェアのコードで描画するSVGです。外部のアイコンフォントや画像素材集は同梱していません。

管理者が独自のシステムアイコンやファビコンを登録する場合は、使用・配布する権利がある画像を用意してください。

## 紹介動画の音声・音楽

[操作デモ](videos/README.md)では、次の音声・音楽を使用しています。

| 素材 | クレジット・利用条件 |
| --- | --- |
| ナレーション | **VOICEVOX:四国めたん**。[VOICEVOX利用規約](https://voicevox.hiroshiba.jp/term/)と[音源利用ガイドライン](https://zunko.jp/con_ongen_kiyaku.html)に従い、クレジットを表示しています。 |
| BGM | **音楽：BGMer「科学と学習」**。[楽曲のページ](https://bgmer.net/music/471/)・[BGMer利用規約](https://bgmer.net/terms/)を確認してください。 |

動画に含まれる音声・音楽・イメージ映像には、本体ソースコードのMITとは別の利用条件があります。これらの素材を取り出して再利用する場合は、元の提供条件を確認してください。イメージ映像は利用場面を表した生成映像で、実施設の記録や導入実績ではありません。
