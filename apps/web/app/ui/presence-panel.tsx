"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { presenceResponseSchema } from "@mame/contracts";
import { elapsedLabel, facilityTime } from "./attendance-display";
import { useResource } from "./use-resource";

export function PresencePanel() {
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [review, setReview] = useState(params.get("review") === "true");
  const [query, setQuery] = useState({ q: "", review: params.get("review") === "true" });
  const [cursors, setCursors] = useState<string[]>([]);
  const search = new URLSearchParams({ limit: "20", ...(query.q ? { q: query.q } : {}), ...(query.review ? { review: "true" } : {}), ...(cursors.length ? { cursor: cursors.at(-1)! } : {}) });
  const { data, error, loading, refresh, authDenied } = useResource(`/api/admin/presence?${search}`, presenceResponseSchema, 30_000);
  function submit(event: FormEvent) { event.preventDefault(); setCursors([]); setQuery({ q: q.trim(), review }); }
  return <section>
    <div className="page-heading"><div><p className="eyebrow">在室状況</p><h1>記録上の在室者</h1><p className="muted">退室が記録されていない人を確認します。</p></div><button className="secondary" onClick={refresh} disabled={loading}>{loading ? "取得中…" : "最新の情報に更新"}</button></div>
    <p className="field-help">実際の滞在を保証する一覧ではありません。「要確認」は入室から12時間以上、または施設の日付を跨いだ記録です。自動退室は行いません。</p>
    <form className="presence-search content-panel" onSubmit={submit}><div><label htmlFor="presence-q">名前・所属で検索</label><input id="presence-q" maxLength={100} value={q} onChange={(event) => setQ(event.target.value)} /></div><label className="checkbox-row"><input type="checkbox" checked={review} onChange={(event) => setReview(event.target.checked)} />要確認の人だけ</label><button disabled={loading}>検索</button></form>
    {error && <div role="alert" className="notice error">{error}{data && " 前回取得時点の情報を表示しています。"}{authDenied && <Link href="/">ログイン画面へ</Link>}</div>}
    {!data && loading && <p role="status">在室記録を取得しています…</p>}
    {data && <section className="content-panel" aria-label="在室一覧"><div className="section-heading"><h2>{query.review ? "要確認の人" : "在室一覧"}{data.total !== undefined && <span className="result-count">{data.total}人</span>}</h2><p className="freshness">取得日時 {facilityTime(data.asOf, data.timeZone)}<span>{data.timeZone} · 30秒ごとに更新</span></p></div>
      {data.items.length ? <ul className="record-list presence-list">{data.items.map((visit) => <li key={visit.id}><div><strong>{visit.person.displayName}</strong><span className="item-meta">{visit.person.affiliation ?? "所属なし"}</span></div><div className="record-times"><span>入室 {facilityTime(visit.enteredAt, data.timeZone)}</span><span>経過 {elapsedLabel(visit.elapsedSeconds)}{visit.needsReview && <span className="review-badge">要確認</span>}</span></div><Link className="row-link" href={`/attendance?personId=${visit.person.id}`}>履歴・訂正<span className="visually-hidden">：{visit.person.displayName}</span></Link></li>)}</ul> : <div className="empty-state"><p>{query.q || query.review ? "条件に一致する在室記録はありません。" : "記録上の在室者はいません。"}</p><p className="muted">{query.q || query.review ? "検索条件を変えて確認できます。" : "QRの未読取がないかも確認してください。"}</p></div>}
      <div className="pagination"><button className="secondary" disabled={loading || !cursors.length} onClick={() => setCursors((old) => old.slice(0, -1))}>前のページ</button><span>{cursors.length + 1}ページ</span><button className="secondary" disabled={loading || !data.nextCursor} onClick={() => { if (data.nextCursor) setCursors((old) => [...old, data.nextCursor!]); }}>次のページ</button></div>
    </section>}
  </section>;
}
