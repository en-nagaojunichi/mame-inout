"use client";

import Link from "next/link";
import { dashboardResponseSchema } from "@mame/contracts";
import { useResource } from "./use-resource";
import { facilityTime, visitStatus } from "./attendance-display";

export function AdminHome() {
  const { data, error, loading, refresh, authDenied } = useResource("/api/admin/dashboard", dashboardResponseSchema, 30_000);
  return <section>
    <div className="page-heading"><div><p className="eyebrow">日々の管理</p><h1>管理ホーム</h1><p className="muted">記録を確認し、必要な対応へ進みます。</p></div><button className="secondary" disabled={loading} onClick={refresh}>{loading ? "取得中…" : "最新の情報に更新"}</button></div>
    {error && <div className="notice error" role="alert">{error}{data && " 表示中の情報は前回取得時点のものです。"}{authDenied && <Link href="/">ログイン画面へ</Link>}</div>}
    {!data && loading && <p role="status">在室状況を取得しています…</p>}
    {data && <>
      <p className="freshness">取得日時：<time dateTime={data.asOf}>{facilityTime(data.asOf, data.timeZone)}</time><span>施設の時刻：{data.timeZone} · 30秒ごとに更新</span></p>
      <section className="dashboard-summary" aria-label="記録上の在室状況">
        <Link href="/presence" className="summary-item"><span>記録上の在室者</span><strong>{data.counts.inside}<small>人</small></strong><span className="summary-link">在室一覧を見る <span aria-hidden="true">→</span></span></Link>
        <Link href="/presence?review=true" className={`summary-item${data.counts.needsReview ? " review-summary" : ""}`}><span>退室忘れなどの要確認</span><strong>{data.counts.needsReview}<small>人</small></strong><span className="summary-link">要確認の人を見る <span aria-hidden="true">→</span></span></Link>
      </section>
      <p className="field-help">QRの未読取や退室忘れにより、実際の滞在とは異なる場合があります。日を跨いでも自動では退室しません。</p>
      {data.counts.needsReview > 0 && <div className="review-notice"><strong>退室の記録を確認してください</strong><p>入室から12時間以上、または施設の日付を跨いでいる記録があります。</p><Link href="/presence?review=true">対象の人を確認する</Link></div>}
      <section className="content-panel" aria-labelledby="recent-title"><div className="section-heading"><div><h2 id="recent-title">最近の入退室記録</h2><p className="muted">今日の入室 {data.counts.todayEntered}件 · 退室 {data.counts.todayExited}件（延べ記録数）</p></div><Link className="text-link" href="/attendance">履歴をすべて見る</Link></div>
        {data.recent.length ? <ul className="record-list">{data.recent.map((visit) => <li key={visit.id}><div><strong>{visit.person.displayName}</strong><span className="item-meta">{visit.person.affiliation ?? "所属なし"}</span></div><div className="record-times"><span>入室 {facilityTime(visit.enteredAt, data.timeZone)}</span><span>{visit.exitedAt ? `退室 ${facilityTime(visit.exitedAt, data.timeZone)}` : visitStatus(visit)}</span></div><Link className="row-link" href={`/attendance?personId=${visit.person.id}`}>履歴を見る<span className="visually-hidden">：{visit.person.displayName}</span></Link></li>)}</ul> : <div className="empty-state"><p>入退室の記録はまだありません。</p><p className="muted">利用者のQRを用意し、承認済みの受付端末で読み取ると記録されます。</p></div>}
      </section>
    </>}
    <section className="content-panel" aria-labelledby="daily-actions-title"><h2 id="daily-actions-title">管理する</h2><ul className="home-action-list">
      <li><Link href="/people"><span><strong>利用者・QRコード</strong><span>利用者を登録する、QRを発行する</span></span><span aria-hidden="true">→</span></Link></li>
      <li><Link href="/settings/devices"><span><strong>QR受付端末</strong><span>端末の申請を確認・承認する</span></span><span aria-hidden="true">→</span></Link></li>
      <li><Link href="/settings/appearance"><span><strong>表示設定</strong><span>システム名・アイコン・ファビコンを変更する</span></span><span aria-hidden="true">→</span></Link></li>
    </ul></section>
    <details className="setup-details"><summary>はじめての受付準備</summary><ol className="setup-guide">
      <li><div><strong>利用者を登録してQRを渡す</strong><p>名前を登録し、QR画像を保存するか印刷します。</p><Link href="/people">利用者を登録・確認</Link></div></li>
      <li><div><strong>入口の端末を申請・承認する</strong><p>受付用のスマホで申請し、管理者が確認コードを照合します。</p><Link href="/settings/devices">端末の申請を確認</Link></div></li>
      <li><div><strong>承認したブラウザで受付を始める</strong><p>入室または退室を選び、利用者のQRを読み取ります。</p><Link href="/reception">このブラウザのQR受付を開く</Link></div></li>
    </ol></details>
  </section>;
}
