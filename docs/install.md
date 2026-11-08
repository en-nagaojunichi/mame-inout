# サーバーへの導入

この手順は、施設で使う方の操作を始める前に、サーバー管理者が行います。サーバーの契約、DNS、証明書、SSHの管理が初めての場合は、それらを管理できる方と一緒に進めてください。日々の利用者登録や受付では、この作業は不要です。

現在は開発版です。正式な配布イメージの公開と、対応環境全体の受入確認はまだ完了していません。出所を確認した検証用配布物を使用し、架空の情報で試してください。

## 準備するもの

| 用意するもの | 確認すること |
| --- | --- |
| Linuxサーバー | Ubuntu 24.04 LTS・amd64を基準とします。sudoを使えること、空き容量2GiB以上、利用可能メモリ1GiB以上が診断の最低条件です。運用データ・他サービスに必要な余裕は別に確保します |
| Docker EngineとComposeプラグイン | [Docker公式のUbuntu導入手順](https://docs.docker.com/engine/install/ubuntu/)に従います。既存Dockerや他のコンテナがある場合は、先に管理者が影響を確認してください |
| 保守に使うプログラム | アプリサーバーにPython 3・GnuPG・OpenSSHクライアントが必要です。Ubuntuでは管理者が `python3`・`gnupg`・`openssh-client` パッケージを準備します |
| 公開URL | 同じ施設では1つのHTTPS URLを使います。例の `https://inout.example.test` は実際のURLへ置き換えます |
| 固定配布物 | `manifest.json`・`images.tar`・`source/` が同じ版で揃っていること。導入先でNext.jsをビルドする必要はありません |
| 別サーバー | 暗号化バックアップと最新の削除台帳を保存します。同じVPS内の別フォルダーでは代用できません |
| 暗号化の鍵2組 | DBバックアップ用と削除台帳用を分けます。通常サーバーへ置くのは公開鍵だけです。復号用の秘密鍵は別の安全な場所へ保管します |

これから作る場所の例は次のとおりです。既存のサービスと同じ名前・保存先を使わないでください。

```text
利用者のスマホ
    ↓ HTTPS
既存のHTTPSサーバー
    ↓ 127.0.0.1:18082
このシステムの専用プロキシ → 画面 / API → 専用PostgreSQL
                                    ↓ 保守処理
                               別サーバーの暗号化保管
```

## 1. 別サーバーに保管先を準備する

この作業は、バックアップを置く側の管理者が行います。Python 3が必要です。

1. 専用のSSHアカウントと、そのアカウントが所有する0700のフォルダーを用意します。例：`/srv/inout-store`。Web公開領域には置きません。
2. 配布物の `source/scripts/operations-store.py` を `/usr/local/lib/mame-inout/operations-store.py` へ配置します。プログラムはroot所有で、専用アカウントが書き換えられないようにします。
3. アプリサーバーのrootが、専用のSSH鍵でそのアカウントへ無対話接続できるようにします。SSHのホスト鍵の指紋は、保管先の管理者から別の経路で確認してください。`StrictHostKeyChecking=no` は使いません。
4. 専用のSSH鍵には、可能なら `authorized_keys` の強制コマンドと `restrict` を設定し、保管プログラム以外の実行を制限します。コマンドの絶対パスと保存先は、この手順の配置先へ合わせてください。

SSH接続名の例は `inout-storage` です。`sudo` で実行する保守処理が使うため、一般ユーザーで接続できるだけでなく、rootのSSH設定・既知ホスト・鍵で接続できることを確認します。パスワードや秘密鍵をチャットへ貼り付ける必要はありません。

削除台帳の最新ポインタ・世代ファイルは手作業で巻き戻したり削除したりしないでください。保管先を丸ごと過去に戻した場合の最新性を、アプリサーバーだけで証明することはできません。別ホストの保管を維持し、可能ならストレージ側の世代保護も有効にします。

## 2. 暗号化用の公開鍵だけを渡す

サーバーとは別の安全な端末で、GnuPGの鍵を2組用意します。パスフレーズ、復号用秘密鍵、失効証明書はその端末側で管理します。鍵を作る際は[GnuPGの説明](https://www.gnupg.org/documentation/)に従ってください。

公開鍵をそれぞれ書き出し、アプリサーバーの公開領域外へ置きます。例：`/etc/inout/ledger-public.asc` と `/etc/inout/backup-public.asc`。ファイルはroot所有0600にします。保守コマンドは、秘密鍵が含まれるファイルと、両用途で同じ鍵を使う設定を拒否します。

復号用の秘密鍵は通常のアプリサーバー、コンテナ、SSH保管先へ一緒に置きません。鍵を更新しても、まだ残すバックアップ世代に対応する旧鍵は保管してください。

## 3. 配布物を展開して設定する

配布物を専用の場所へ展開します。例：`/opt/inout/releases/0.1.0-dev.m06/`。その中に `source/`・`manifest.json`・`images.tar` があることを確認してください。提供元から別経路で受け取った配布物の指紋も照合します。同梱manifestだけでは提供元の真正性までは証明できません。

次は例のパスです。実際に展開した場所へ合わせて実行してください。

```sh
sudo install -d -m 0700 /etc/inout
sudo python3 /opt/inout/releases/0.1.0-dev.m06/source/scripts/operations.py --config /etc/inout/operations.json configure
```

画面の質問には次の内容を入力します。秘密の値そのものを入力する欄はありません。

| 質問 | 入力例・判断方法 |
| --- | --- |
| 専用プロジェクト名 | `mame-inout-facility`。既存コンテナのプロジェクト名と重ねません |
| 配布物 | `/opt/inout/releases/0.1.0-dev.m06` |
| 専用保管先 | `/var/lib/inout-facility`。まだ存在しない場所を指定します |
| HTTPSのURL | 実際に使うURL。末尾の `/` は付けません |
| 内部ポート | `18082` など、既存サービスが使っていない1024以上の番号 |
| 外部SSH接続名・保管先 | 手順1で用意した接続名と絶対パス |
| 公開鍵2つ | 手順2で置いたファイルの絶対パス |
| 既存の秘密フォルダー | 新規導入は空欄。既存環境の更新の場合だけ、元の資格情報の場所を指定します |

外部保管への接続だけ失敗した場合は、接続先・SSHの権限を直して同じ `configure` を再実行します。既に完成した設定と秘密情報は上書きしません。

## 4. 診断して起動する

```sh
sudo python3 /opt/inout/releases/0.1.0-dev.m06/source/scripts/operations.py --config /etc/inout/operations.json diagnose
sudo python3 /opt/inout/releases/0.1.0-dev.m06/source/scripts/operations.py --config /etc/inout/operations.json install
```

診断が止まった場合は、表示された対象を直してから再実行します。容量不足を解消するために既存DBや他サービスのファイルを削除しないでください。導入途中で停止した場合も、同じ設定の `install` で再開します。

起動するのは専用のDB・API・画面・プロキシだけです。DBポートを外部へ公開せず、画面にDB資格を渡しません。API用、移行用、バックアップ用、保持・削除用のDB資格を分けます。

## 5. HTTPSの接続先を追加する

保守コマンドは既存のNginxや証明書の設定を書き換えません。HTTPSを管理する方が、配布物の `source/infra/nginx.conf.example` を元に、新しいホスト名だけを `127.0.0.1:18082` へ接続します。ポートは設定した番号へ合わせます。

既存の80・443番を使うサービスがある場合、`compose.https.yaml` をそのまま追加起動しないでください。Nginxの設定検査に成功してからreloadし、既存サイトと新しいサイトの両方を確認します。TLS証明書の警告は無視せず直してください。

## 6. 最初の管理者とテスト受付を準備する

配布物の `source/` で、同じCompose設定を指定して初期設定コードを発行します。保守設定で生成された `runtime.env` は参照だけで、秘密の内容は表示しません。

```sh
sudo docker --host unix:///var/run/docker.sock compose --project-name mame-inout-facility --env-file /var/lib/inout-facility/runtime.env -f compose.yaml -f compose.nginx.yaml exec api node dist/setup-code.js /tmp/initial-setup-code
```

コードはAPIコンテナ内の指定した新規ファイルへ保存され、コマンドの出力には表示しません。出力を記録しない安全な対話端末でそのファイルを確認し、最初の管理者だけへ渡します。ファイルが既にあれば上書きせず、別の新しいファイル名を指定してください。使用後はファイルを削除します。コードを公開ログ・チャット・画面共有へ載せないでください。

[画面の使い方](usage.md)の「最初の管理者を登録する」に進み、架空利用者を1人登録して、QR受付端末の申請・承認、入室、退室まで確認します。iPhoneはSafari、AndroidはChromeアプリで開いてください。

## 7. 自動保守と復元確認を有効にする

```sh
sudo python3 /opt/inout/releases/0.1.0-dev.m06/source/scripts/operations.py --config /etc/inout/operations.json enable-maintenance
sudo python3 /opt/inout/releases/0.1.0-dev.m06/source/scripts/operations.py --config /etc/inout/operations.json backup
```

削除の保守は5分ごと、期限を過ぎた終了済み履歴の削除は1日1回実行します。未退室の記録は期限だけで消しません。別サーバーの停止などで個人情報を削除できなければ「保留」のままになり、次回に再試行します。

同時に、毎日03:30（サーバーの時刻設定）にDBバックアップを取得する専用タイマーを有効にします。失敗していないか監視し、施設の運用時間に合わせて実行時刻を管理してください。[バックアップ・復元](operations.md)で、空の別環境から戻せることまで確認してから運用を開始します。
