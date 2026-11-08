"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { privacyResponseSchema, retentionPreviewSchema, retentionDaysSchema, securityResponseSchema, type PrivacyResponse, type RetentionPreview } from "@mame/contracts";
import { api, ApiFailure, authClient, dateLabel, requirePasskey } from "./client-api";
import { Modal } from "./modal";

export async function privacyAuthenticate() {
  const before = await api("/api/admin/security", securityResponseSchema);
  // 直近の本人確認を再利用し、同じ操作で何度もパスキーを要求しない。
  if (before.recentAuth) return;
  requirePasskey();
  const result = await authClient.signIn.passkey();
  if (result.error) throw new Error("本人確認は完了していません。パスキーを選び直してください。");
  const after = await api("/api/admin/security", securityResponseSchema);
  if (after.currentUserId !== before.currentUserId) throw new Error("別の管理者でログインしました。画面を開き直して対象を確認してください。");
}

export function PrivacyPanel() {
  const [current, setCurrent] = useState<PrivacyResponse | null>(null);
  const [days, setDays] = useState("365");
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [failure, setFailure] = useState(false);
  const [modalError, setModalError] = useState("");
  const previewOpener = useRef<HTMLButtonElement | null>(null);
  const notice = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    let active = true;
    void api("/api/admin/privacy", privacyResponseSchema).then((value) => { if (active) { setCurrent(value); setDays(String(value.retention.days)); } })
      .catch((cause: unknown) => { if (active) { setFailure(true); setMessage(cause instanceof Error ? cause.message : "設定を読み込めませんでした。"); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function reload() {
    setLoading(true); setMessage("");
    try { const value = await api("/api/admin/privacy", privacyResponseSchema); setCurrent(value); setDays(String(value.retention.days)); }
    catch (cause) { if (cause instanceof ApiFailure && [401, 403].includes(cause.status)) setCurrent(null); setFailure(true); setMessage(cause instanceof Error ? cause.message : "状態を読み込めませんでした。"); }
    finally { setLoading(false); }
  }
  async function inspect() {
    const value = retentionDaysSchema.safeParse(Number(days));
    if (!value.success) { setFailure(true); setMessage("保存期間を1〜3650日の整数で入力してください。"); return; }
    setBusy(true); setMessage(""); setModalError("");
    try { setPreview(await api("/api/admin/privacy/retention-preview", retentionPreviewSchema, { days: value.data })); }
    catch (cause) { if (cause instanceof ApiFailure && [401, 403].includes(cause.status)) setCurrent(null); setFailure(true); setMessage(cause instanceof Error ? cause.message : "削除予定件数を確認できませんでした。"); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview || !current) return;
    setBusy(true); setModalError("");
    try {
      await privacyAuthenticate();
      const updated = await api("/api/admin/privacy/retention", privacyResponseSchema, { days: preview.days, expectedVersion: preview.expectedVersion, confirmationToken: preview.confirmationToken }, "PUT");
      setCurrent(updated); setDays(String(updated.retention.days)); setPreview(null);
      setFailure(false); setMessage("保存期間を変更しました。期限を過ぎた終了済みの記録は、次の日次処理で削除されます。");
      requestAnimationFrame(() => notice.current?.focus());
    } catch (cause) { if (cause instanceof ApiFailure && [401, 403].includes(cause.status)) { setCurrent(null); setPreview(null); setFailure(true); setMessage(cause.message); } else setModalError(cause instanceof Error ? cause.message : "保存を確認できませんでした。状態を読み直して確認してください。"); }
    finally { setBusy(false); }
  }
  return <section>
    <div className="page-heading"><div><p className="eyebrow">システムの設定</p><h1>保存と削除</h1><p className="muted">記録を残す期間と、個人情報削除の進み具合を確認します。</p></div></div>
    {message && <p ref={notice} tabIndex={-1} className={`notice ${failure ? "error" : "success"}`} role={failure ? "alert" : "status"}>{message}</p>}
    {loading && <p role="status">保存設定を読み込んでいます…</p>}
    {!loading && !current && <button onClick={() => void reload()}>設定を読み直す</button>}
    {current && <>
      <section className="content-panel"><h2>記録の保存期間</h2><p>終了済みの入退室履歴・訂正履歴と監査記録を、指定した日数だけ残します。未退室の記録は期間だけで消えません。</p>
        <ol className="privacy-steps"><li>残す日数を入力</li><li>削除予定件数を確認</li><li>パスキーで本人確認して保存</li></ol>
        <form onSubmit={(event) => { event.preventDefault(); void inspect(); }}><label htmlFor="retention-days">記録を残す日数</label><div className="inline-actions"><input id="retention-days" type="number" min="1" max="3650" step="1" required value={days} disabled={busy || loading} onChange={(event) => setDays(event.target.value)} style={{ maxWidth: "10rem" }} /><span>日</span></div><p className="field-help">現在は{current.retention.days}日です。1日は24時間として計算します。削除した記録は画面から元に戻せません。</p><button ref={previewOpener} disabled={busy || loading || Number(days) === current.retention.days}>{busy ? "確認しています…" : "削除予定件数を確認"}</button></form>
        <h3>前回の日次処理</h3><p>{current.retention.lastRunAt ? `${dateLabel(current.retention.lastRunAt)}：入退室 ${current.retention.lastDeletedVisits}件・監査 ${current.retention.lastDeletedAuditEvents}件を削除` : "実行結果はまだありません。サーバー管理者が日次処理の設定を確認してください。"}</p>
      </section>
      <section className="content-panel"><h2>個人情報の削除</h2><p>利用を一時的に止める場合は「利用停止」を使います。氏名などを消す場合は、<Link href="/people">利用者一覧</Link>で対象者の「個人情報を削除」へ進んでください。</p><p>削除指示を外部へ保管した後に、個人情報を削除します。外部への保管に失敗した場合は保留になり、日次処理で再試行します。</p>
        <div className="notice" role="status">{current.pendingCount > 0 ? `${current.pendingCount}件が処理待ちです。まだ削除完了ではありません。` : "処理待ちの削除指示はありません。"}</div>
        <button className="secondary" disabled={busy || loading} onClick={() => void reload()}>処理状態を更新</button>
        {current.deletions.length > 0 && <ul className="people-list">{current.deletions.map((item) => <li key={item.operationId}><div><h3>{item.state === "COMPLETED" ? "削除完了" : item.errorCode ? "保留・再試行待ち" : "処理待ち"}</h3><p>指示：{dateLabel(item.requestedAt)}{item.completedAt && <> ／完了：{dateLabel(item.completedAt)}</>}</p><p className="field-help">処理番号：{item.operationId}</p>{item.errorCode && <p className="field-error">{item.errorCode === "EXTERNAL_STORAGE_UNAVAILABLE" ? "外部への保管を確認できません。サーバー管理者へ連絡してください。" : "削除処理を完了できません。サーバー管理者へ連絡してください。"}</p>}</div></li>)}</ul>}
        <p className="field-help">直近の最大100件を表示します。内部参照IDと入退室時刻は履歴に残り、「削除済み利用者」と表示されます。バックアップには個人情報が残る場合があります。バックアップの保持設定は{current.retention.backupRetentionDays}日です。外部保管や手動コピーの削除もサーバー管理者が管理します。</p>
      </section>
    </>}
    <Modal open={preview !== null} title="保存期間の変更を確認" description="日数を短くすると、次の日次処理で過去の記録が削除されます。対象件数と、残す期間を確認してください。" busy={busy} returnFocusRef={previewOpener} onClose={() => setPreview(null)}>
      {preview && <><dl className="detail-grid"><dt>変更後の期間</dt><dd>{preview.days}日</dd><dt>削除予定の入退室</dt><dd>{preview.visits}件（訂正履歴{preview.revisions}件）</dd><dt>削除予定の監査</dt><dd>{preview.auditEvents}件</dd><dt>未退室の保護</dt><dd>{preview.openVisits}件は削除しません</dd></dl><p className="field-help">境界日時：{dateLabel(preview.cutoff)}。実行時に件数が変わった場合は、もう一度確認が必要です。</p></>}
      {modalError && <p className="notice error" role="alert">{modalError} 件数の確認に戻って、状態を確認できます。</p>}
      <div className="inline-actions"><button data-modal-initial className="secondary" disabled={busy} onClick={() => setPreview(null)}>件数の確認に戻る</button><button disabled={busy} onClick={() => void save()}>{busy ? "保存しています…" : "本人確認して保存"}</button></div>
    </Modal>
  </section>;
}
