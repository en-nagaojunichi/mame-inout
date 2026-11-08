"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { deletionPreviewSchema, deletionStatusSchema, type DeletionPreview, type DeletionStatus } from "@mame/contracts";
import { api, ApiFailure, dateLabel } from "./client-api";
import { privacyAuthenticate } from "./privacy-panel";
import { Modal } from "./modal";

export function PersonDeletionPanel({ personId }: { personId: string }) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null), [result, setResult] = useState<DeletionStatus | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  // 応答を受け取れなくても同じ処理番号で再送し、別の削除指示を作らない。
  const operation = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void api(`/api/admin/people/${encodeURIComponent(personId)}/deletion-preview`, deletionPreviewSchema)
      .then((value) => { if (active) setPreview(value); })
      .catch((cause: unknown) => { if (active) setMessage(cause instanceof Error ? cause.message : "対象者を確認できませんでした。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [personId]);
  async function erase() {
    if (!preview) return;
    setBusy(true); setMessage("");
    operation.current ??= crypto.randomUUID();
    try {
      await privacyAuthenticate();
      const value = await api(`/api/admin/people/${encodeURIComponent(personId)}/deletion`, deletionStatusSchema, { operationId: operation.current, expectedVersion: preview.version });
      setResult(value); setConfirming(false);
    } catch (cause) { if (cause instanceof ApiFailure && [401, 403].includes(cause.status)) { setPreview(null); setConfirming(false); } setMessage(cause instanceof Error ? cause.message : "削除指示の受付を確認できませんでした。処理状態を確認してください。"); }
    finally { setBusy(false); }
  }
  return <section>
    <p><Link href="/people">← 利用者一覧へ戻る</Link></p>
    <div className="page-heading"><div><p className="eyebrow">利用者の管理</p><h1>個人情報の削除</h1><p className="muted">利用停止とは違い、氏名などを消す操作です。元には戻せません。</p></div></div>
    {loading && <p role="status">対象者と影響を確認しています…</p>}
    {message && !confirming && <p className="notice error" role="alert">{message}</p>}
    {result ? <section className="content-panel"><h2>{result.state === "COMPLETED" ? "個人情報を削除しました" : "削除指示を受け付けました"}</h2><p role="status">{result.state === "COMPLETED" ? `完了：${dateLabel(result.completedAt)}` : "受付とQRを停止しました。外部への削除指示の保管と、個人情報の削除はまだ完了していません。"}</p><p className="field-help">処理番号：{result.operationId}</p><Link className="button-link" href="/settings/privacy">削除の処理状態を確認</Link></section>
      : preview && <>
        <section className="content-panel"><h2>対象：{preview.displayName}</h2><p>一時的に利用を止めるだけの場合は、この操作をせず、利用者一覧の「利用停止」を選んでください。</p><h3>消す情報</h3><ul><li>氏名・ふりがな・所属・利用者コード</li><li>QR資格と、受付結果に含まれる個人情報</li><li>訂正理由など、関連する記録に複製された個人情報</li></ul><h3>残る情報</h3><p>内部参照IDと入退室時刻は残り、履歴では「削除済み利用者」と表示します。完全な匿名化ではありません。</p><p>対象の入退室履歴：{preview.visits}件、訂正履歴：{preview.revisions}件。</p><div className="notice">バックアップには削除前の情報が残る場合があります。バックアップの保持設定は{preview.backupRetentionDays}日です。外部保管・手動コピーもサーバー管理者が管理します。復元時は、公開する前に最新の削除指示をもう一度適用します。</div></section>
        <section className="content-panel"><h2>削除の進み方</h2><ol className="privacy-steps"><li>パスキーで本人確認して削除を指示</li><li>受付を停止し、削除指示を外部へ保管</li><li>個人情報を削除し、完了を記録</li></ol><p>外部への保管に失敗した場合は「保留」になります。指示を出した直後には、削除完了と表示しません。</p>{preview.openVisits > 0 && <p className="notice error" role="alert">未退室の記録が{preview.openVisits}件あります。履歴で内容を確認し、必要な訂正をしてから削除してください。期限だけで自動退室はしません。<Link href={`/attendance?personId=${encodeURIComponent(personId)}`}>対象者の履歴へ</Link></p>}<button className="danger-button" disabled={busy || preview.openVisits > 0} onClick={() => { setMessage(""); setConfirming(true); }}>影響を確認して削除へ進む</button></section>
      </>}
    {!loading && !preview && <p><Link href="/people">利用者一覧から最新の状態を確認してください。</Link> 受付済みの削除指示は<Link href="/settings/privacy">保存と削除</Link>で確認できます。</p>}
    <Modal open={confirming} title="個人情報の削除を指示" description={`「${preview?.displayName ?? ""}」の受付を停止し、外部への削除指示の保管後に個人情報を消します。元に戻せません。内部参照IDと入退室時刻は残ります。`} busy={busy} onClose={() => setConfirming(false)}>
      {message && <p className="notice error" role="alert">{message} 応答が不明な場合は「保存と削除」で処理状態を確認できます。</p>}
      <div className="inline-actions"><button data-modal-initial className="secondary" disabled={busy} onClick={() => setConfirming(false)}>キャンセル</button><button className="danger-button" disabled={busy} onClick={() => void erase()}>{busy ? "本人確認・受付中…" : "本人確認して削除を指示"}</button></div>
    </Modal>
  </section>;
}
