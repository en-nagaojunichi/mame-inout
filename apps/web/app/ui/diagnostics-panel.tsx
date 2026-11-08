"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { diagnosticsResponseSchema, type DiagnosticsResponse } from "@mame/contracts";
import { api, ApiFailure, dateLabel } from "./client-api";

export function DiagnosticsPanel() {
  const [value, setValue] = useState<DiagnosticsResponse | null>(null), [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void api("/api/admin/diagnostics", diagnosticsResponseSchema).then((result) => { if (active) setValue(result); })
      .catch((cause: unknown) => { if (active) setMessage(cause instanceof Error ? cause.message : "稼働状況を取得できませんでした。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function reload() {
    setLoading(true); setMessage("");
    try { setValue(await api("/api/admin/diagnostics", diagnosticsResponseSchema)); }
    catch (cause) { if (cause instanceof ApiFailure && [401, 403].includes(cause.status)) setValue(null); setMessage(cause instanceof Error ? cause.message : "状況を確認できませんでした。"); }
    finally { setLoading(false); }
  }
  return <section><div className="page-heading"><div><p className="eyebrow">システムの設定</p><h1>稼働状況</h1><p className="muted">接続と保守処理の状況を確認できます。問題がある場合は、この内容をサーバー管理者に伝えてください。</p></div><button className="secondary" disabled={loading} onClick={() => void reload()}>状況を更新</button></div>
    {message && <p className="notice error" role="alert">{message} 前回の表示がある場合も、最新の状態を確認できていません。</p>}
    {loading && <p role="status">稼働状況を確認しています…</p>}
    {value && <><p className="field-help">最終確認：{dateLabel(value.checkedAt)}</p><section className="content-panel"><h2>接続とパスキー</h2><dl className="detail-grid"><dt>公開URL</dt><dd>{value.origin}</dd><dt>暗号化通信</dt><dd>{value.https ? "HTTPSが設定されています" : "HTTPの設定です。公開運用する前にHTTPSを設定してください"}</dd><dt>記録への接続</dt><dd>接続を確認できました</dd><dt>パスキーの対象</dt><dd>{value.passkey.rpId}</dd><dt>パスキーの本人確認</dt><dd>必須</dd></dl><p className="field-help">この表示はサーバーの設定と接続結果です。端末で実際にパスキーを使えるかは、Safari・Chromeでログインして確認してください。</p></section>
      <section className="content-panel"><h2>バックアップと保存</h2><p>{value.backup.lastCompletedAt && value.backup.externalConfirmed ? `外部保管を確認した最終バックアップ：${dateLabel(value.backup.lastCompletedAt)}` : "外部保管まで成功したバックアップは、まだ確認できていません。サーバー管理者が保管先・日次処理を確認してください。"}</p><p>バックアップの保持設定：{value.backup.retentionDays}日</p><p>期限削除の最終実行：{dateLabel(value.privacy.lastRetentionRunAt)}</p><p>個人情報削除の処理待ち：{value.privacy.pendingDeletions}件</p><Link href="/settings/privacy">保存設定と削除の進み具合へ</Link></section>
      <section className="content-panel"><h2>使用可能な容量</h2>{value.disk ? <p>アプリから見える空き容量：{(value.disk.availableBytes / 1024 ** 3).toFixed(1)}GB ／ {(value.disk.totalBytes / 1024 ** 3).toFixed(1)}GB</p> : <p>容量を取得できませんでした。サーバー管理者が確認してください。</p>}<p className="field-help">アプリの実行領域で確認できる値です。記録用ディスク・バックアップ先・サーバー全体の容量は、サーバー管理者が診断コマンドで確認してください。</p></section></>}
  </section>;
}
