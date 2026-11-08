"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  attendanceDetailResponseSchema, attendanceHistoryResponseSchema, attendancePatchInputSchema, manualVisitInputSchema,
  peopleResponseSchema, securityResponseSchema, visitDtoSchema,
  type AttendanceDetailResponse, type SecurityResponse,
} from "@mame/contracts";
import type { z } from "zod";
import { api, ApiFailure, authClient, requirePasskey } from "./client-api";
import { facilityTime, inputTimeToUtc, localTimeInput, visitStatus } from "./attendance-display";
import { Modal } from "./modal";
import { useResource } from "./use-resource";

type Filters = { q: string; from: string; to: string; status: string; personId: string; affiliation: string; source: string; corrected: string };
type Person = z.infer<typeof peopleResponseSchema>["items"][number];
type Action = { kind: "detail" | "edit" | "cancel"; detail: AttendanceDetailResponse } | { kind: "manual"; requestId: string } | { kind: "csv"; query: Filters };
const emptyFilters: Filters = { q: "", from: "", to: "", status: "all", personId: "", affiliation: "", source: "all", corrected: "all" };
function paramsFor(query: Filters) { return new URLSearchParams(Object.entries(query).filter(([, value]) => Boolean(value))); }
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作を完了できませんでした。";

export function HistoryPanel() {
  const url = useSearchParams();
  const [fields, setFields] = useState({ ...emptyFilters, personId: url.get("personId") ?? "" });
  const [query, setQuery] = useState(fields);
  const [cursors, setCursors] = useState<string[]>([]);
  const search = paramsFor(query); search.set("limit", "20"); if (cursors.length) search.set("cursor", cursors.at(-1)!);
  const records = useResource(`/api/admin/attendance?${search}`, attendanceHistoryResponseSchema);
  const security = useResource("/api/admin/security", securityResponseSchema);
  const [verified, setVerified] = useState<SecurityResponse | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState("");
  const [modalError, setModalError] = useState("");
  const [reason, setReason] = useState("");
  const [entered, setEntered] = useState("");
  const [exited, setExited] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Person | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const resultNotice = useRef<HTMLDivElement | null>(null);
  const timeZone = records.data?.timeZone ?? "Asia/Tokyo";
  const identity = verified ?? security.data;
  const important = action && action.kind !== "detail";
  // 取消後に元の行が一覧から消える場合も、保存結果から次の操作へ進める位置を残す。
  useEffect(() => { if (notice) resultNotice.current?.focus(); }, [notice]);

  function remember() { if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement; }
  function start(next: Action) {
    if (!action) remember();
    setModalError(""); setBlocked(false); setReason(""); setAction(next);
    if (next.kind === "manual") {
      setSelected(null); setPeople([]); setPersonQuery("");
      setEntered(localTimeInput(records.data?.asOf ?? new Date().toISOString(), timeZone)); setExited("");
    } else if (next.kind === "edit" || next.kind === "cancel") {
      setEntered(localTimeInput(next.detail.visit.enteredAt, next.detail.timeZone));
      setExited(next.detail.visit.exitedAt ? localTimeInput(next.detail.visit.exitedAt, next.detail.timeZone) : "");
    }
  }

  async function openDetail(id: string) {
    if (!action) remember();
    setOpening(true); setNotice(""); setModalError("");
    try {
      const detail = await api(`/api/admin/attendance/${id}`, attendanceDetailResponseSchema);
      if (detail.visit.id !== id) throw new Error("記録の対象を確認できませんでした。最新の情報に更新してください。");
      setBlocked(false); setAction({ kind: "detail", detail });
    } catch (error) { if (action) setModalError(messageOf(error)); else setNotice(messageOf(error)); }
    finally { setOpening(false); }
  }

  async function identityBeforeAction() {
    if (!security.data) throw new Error("管理者の本人確認状態を取得できませんでした。画面を読み直してください。");
    const current = await api("/api/admin/security", securityResponseSchema);
    if (current.currentUserId !== security.data.currentUserId) {
      setBlocked(true); throw new Error("ログイン中の管理者が変わりました。閉じて画面を読み直してください。");
    }
    setVerified(current); return current;
  }

  async function authenticate() {
    setBusy(true); setModalError("");
    try {
      await identityBeforeAction(); requirePasskey();
      const result = await authClient.signIn.passkey();
      if (result.error) throw new Error("本人確認は完了していません。もう一度お試しください。");
      if (!(await identityBeforeAction()).recentAuth) throw new Error("本人確認を確認できませんでした。");
    } catch (error) { setModalError(messageOf(error)); }
    finally { setBusy(false); }
  }

  async function searchPeople() {
    setBusy(true); setModalError("");
    try {
      const result = await api(`/api/admin/people?${new URLSearchParams({ q: personQuery.trim(), status: "ACTIVE", limit: "20" })}`, peopleResponseSchema);
      setPeople(result.items);
      if (!result.items.length) setModalError("利用者が見つかりません。名前や所属を変えて検索してください。");
    } catch (error) { setModalError(messageOf(error)); }
    finally { setBusy(false); }
  }

  async function moreRevisions() {
    if (!action || action.kind !== "detail" || !action.detail.nextCursor) return;
    setBusy(true); setModalError("");
    try {
      const next = await api(`/api/admin/attendance/${action.detail.visit.id}?cursor=${action.detail.nextCursor}&limit=20`, attendanceDetailResponseSchema);
      if (next.visit.id !== action.detail.visit.id || next.visit.version !== action.detail.visit.version) throw new Error("記録が更新されています。詳細を読み直してください。");
      const existing = new Set(action.detail.revisions.map((row) => row.id));
      setAction({ kind: "detail", detail: { ...next, revisions: [...action.detail.revisions, ...next.revisions.filter((row) => !existing.has(row.id))] } });
    } catch (error) { setModalError(messageOf(error)); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); if (!action || action.kind === "detail" || busy || blocked) return;
    setBusy(true); setModalError("");
    let sent = false;
    try {
      if (!(await identityBeforeAction()).recentAuth) throw new Error("本人確認の有効時間が過ぎました。パスキーで本人確認してから実行してください。");
      if (action.kind === "csv") {
        const response = await fetch(`/api/admin/attendance.csv?${paramsFor(action.query)}`, { cache: "no-store" });
        if (!response.ok) {
          const data = await response.json().catch(() => null) as { message?: string; code?: string } | null;
          throw new ApiFailure(data?.message ?? "CSVを作成できませんでした。検索条件を絞ってお試しください。", response.status, data?.code);
        }
        if (!response.headers.get("Content-Type")?.startsWith("text/csv")) throw new Error("CSVの形式を確認できませんでした。");
        const blob = await response.blob(); await identityBeforeAction();
        const href = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = href; link.download = "入退室履歴.csv"; document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
        setAction(null); setNotice("CSVのダウンロードを開始しました。個人情報を含むため、保存先と共有先に注意してください。"); return;
      }
      const zone = action.kind === "manual" ? timeZone : action.detail.timeZone;
      const enteredAt = action.kind === "cancel" ? action.detail.visit.enteredAt : inputTimeToUtc(entered, zone, action.kind === "edit" ? action.detail.visit.enteredAt : undefined);
      const exitedAt = action.kind === "cancel" ? action.detail.visit.exitedAt : exited ? inputTimeToUtc(exited, zone, action.kind === "edit" ? action.detail.visit.exitedAt ?? undefined : undefined) : null;
      if (action.kind === "manual") {
        const input = manualVisitInputSchema.safeParse({ personId: selected?.id, enteredAt, exitedAt, reason, requestId: action.requestId });
        if (!input.success) throw new Error("利用者、入退室の日時、変更理由を確認してください。");
        sent = true;
        const saved = await api("/api/admin/attendance", visitDtoSchema, input.data);
        if (saved.personId !== selected?.id) throw new Error("追加結果の対象を確認できませんでした。");
      } else {
        const input = attendancePatchInputSchema.safeParse({ expectedVersion: action.detail.visit.version, enteredAt, exitedAt, cancel: action.kind === "cancel", reason });
        if (!input.success) throw new Error("入退室の日時と変更理由を確認してください。");
        sent = true;
        const saved = await api(`/api/admin/attendance/${action.detail.visit.id}`, visitDtoSchema, input.data, "PATCH");
        if (saved.id !== action.detail.visit.id || saved.version !== action.detail.visit.version + 1) throw new Error("変更結果の記録を確認できませんでした。");
      }
      setAction(null); setNotice(action.kind === "manual" ? "記録を追加しました。" : action.kind === "cancel" ? "記録を取り消しました。取消済みの条件で確認できます。" : "記録を訂正しました。"); records.refresh();
    } catch (error) {
      if (error instanceof ApiFailure && error.code === "REAUTH_REQUIRED") setVerified((old) => old ? { ...old, recentAuth: false } : old);
      if (error instanceof ApiFailure && error.code === "VERSION_CONFLICT") setBlocked(true);
      // 書き込み後の通信断では未登録と断定せず、履歴の確認が済むまで同じ操作を重ねない。
      if (sent && (!(error instanceof ApiFailure) || error.status >= 500)) {
        setBlocked(true); setModalError("保存結果を確認できません。閉じて最新の履歴を確認してください。確認するまでは同じ記録を追加しないでください。");
      } else setModalError(messageOf(error));
    } finally { setBusy(false); }
  }

  function filter(event: FormEvent) { event.preventDefault(); setCursors([]); setQuery({ ...fields, q: fields.q.trim() }); setNotice(""); }
  const title = action?.kind === "detail" ? "記録の詳細・変更履歴" : action?.kind === "edit" ? "入退室時刻を訂正" : action?.kind === "cancel" ? "記録を取り消す" : action?.kind === "manual" ? "手動で記録を追加" : "CSVをダウンロード";
  return <section>
    <div className="page-heading"><div><p className="eyebrow">記録の確認</p><h1>入退室履歴</h1><p className="muted">検索した記録を確認し、必要に応じて訂正します。</p></div><button disabled={!records.data || !security.data || opening} onClick={() => start({ kind: "manual", requestId: crypto.randomUUID() })}>手動で記録を追加</button></div>
    <form onSubmit={filter} className="history-search content-panel"><div><label htmlFor="history-from">開始日</label><input id="history-from" type="date" value={fields.from} onChange={(event) => setFields({ ...fields, from: event.target.value })} /></div><div><label htmlFor="history-to">終了日</label><input id="history-to" type="date" value={fields.to} onChange={(event) => setFields({ ...fields, to: event.target.value })} /></div><div className="history-q"><label htmlFor="history-q">名前・所属で検索</label><input id="history-q" maxLength={100} value={fields.q} onChange={(event) => setFields({ ...fields, q: event.target.value })} /></div><div><label htmlFor="history-status">状態</label><select id="history-status" value={fields.status} onChange={(event) => setFields({ ...fields, status: event.target.value })}><option value="all">有効な記録すべて</option><option value="inside">記録上の在室中</option><option value="completed">退室済み</option><option value="canceled">取消済み</option></select></div><button disabled={records.loading}>検索</button><details className="advanced-filters"><summary>詳しい条件</summary><div className="advanced-filter-fields"><div><label htmlFor="history-affiliation">所属で絞り込み</label><input id="history-affiliation" maxLength={100} value={fields.affiliation} onChange={(event) => setFields({ ...fields, affiliation: event.target.value })} /></div><div><label htmlFor="history-source">記録方法</label><select id="history-source" value={fields.source} onChange={(event) => setFields({ ...fields, source: event.target.value })}><option value="all">すべて</option><option value="RECEPTION">QR受付</option><option value="MANUAL">手動追加</option></select></div><div><label htmlFor="history-corrected">訂正の有無</label><select id="history-corrected" value={fields.corrected} onChange={(event) => setFields({ ...fields, corrected: event.target.value })}><option value="all">すべて</option><option value="true">訂正あり</option><option value="false">訂正なし</option></select></div></div></details><p className="field-help">期間は入室日で絞ります（施設の時刻：{timeZone}）。通常の検索には取消済みを含みません。</p>{fields.personId && <div className="person-filter">選択した利用者に絞り込み中<button type="button" className="text-button" onClick={() => { const next = { ...fields, personId: "" }; setFields(next); setQuery(next); setCursors([]); }}>利用者の絞り込みを解除</button></div>}</form>
    {notice && <div className="notice" role="status" tabIndex={-1} ref={resultNotice}>{notice}</div>}
    {records.error && <div className="notice error" role="alert">{records.error}{records.data && " 表示中の情報は前回取得時点のものです。"}{records.authDenied && <Link href="/">ログイン画面へ</Link>}</div>}
    <div className="history-toolbar"><button className="secondary" onClick={records.refresh} disabled={records.loading}>最新の情報に更新</button><button className="secondary" disabled={!records.data || !security.data} onClick={() => start({ kind: "csv", query })}>CSVをダウンロード</button></div>
    {!records.data && records.loading && <p role="status">履歴を取得しています…</p>}
    {records.data && <section className="content-panel" aria-label="入退室履歴の一覧"><div className="section-heading"><h2>検索結果{records.data.total !== undefined && <span className="result-count">{records.data.total}件</span>}</h2><p className="freshness">{records.data.asOf && `取得日時 ${facilityTime(records.data.asOf, timeZone)}`}<span>{timeZone}</span></p></div>
      {records.data.items.length ? <ul className="record-list">{records.data.items.map((visit) => <li key={visit.id}><div><strong>{visit.person.displayName}</strong><span className="item-meta">{visit.person.affiliation ?? "所属なし"} · {visit.source === "MANUAL" ? "手動追加" : "QR受付"}{visit.corrected && " · 訂正あり"}</span></div><div className="record-times"><span>入室 {facilityTime(visit.enteredAt, timeZone)}</span><span>退室 {visit.exitedAt ? facilityTime(visit.exitedAt, timeZone) : "記録なし"}</span><span className="record-status">{visitStatus(visit)}</span></div><button className="secondary small-button" disabled={opening} onClick={() => void openDetail(visit.id)}>詳細・訂正<span className="visually-hidden">：{visit.person.displayName}</span></button></li>)}</ul> : <div className="empty-state"><p>条件に一致する記録はありません。</p><p className="muted">検索条件を変えるか、必要であれば記録を手動で追加できます。</p></div>}
      <div className="pagination"><button className="secondary" disabled={records.loading || !cursors.length} onClick={() => setCursors((old) => old.slice(0, -1))}>前のページ</button><span>{cursors.length + 1}ページ</span><button className="secondary" disabled={records.loading || !records.data.nextCursor} onClick={() => { if (records.data?.nextCursor) setCursors((old) => [...old, records.data!.nextCursor!]); }}>次のページ</button></div>
    </section>}
    {opening && <p role="status">記録の詳細を取得しています…</p>}
    <Modal open={action !== null} title={title} description={action?.kind === "csv" ? "確定した検索条件の全ページをCSVにします。上限は10,000件です。個人情報の扱いに注意してください。" : action?.kind === "cancel" ? "この記録を在室状況と通常の集計から除外します。元の記録と変更理由は変更履歴に残ります。" : action?.kind === "detail" ? "現在の記録と、管理者による変更前後を確認できます。" : "施設の時刻で入力してください。変更前後・実行者・理由は変更履歴に残ります。"} busy={busy} returnFocusRef={opener} onClose={() => setAction(null)}>
      {modalError && <div role="alert" className="notice error">{modalError}</div>}
      {action && "detail" in action && <div className="visit-target"><strong>{action.detail.visit.person.displayName}</strong><p>{facilityTime(action.detail.visit.enteredAt, action.detail.timeZone)} → {facilityTime(action.detail.visit.exitedAt, action.detail.timeZone)}</p><span className="status-label">{visitStatus(action.detail.visit)}</span></div>}
      {action?.kind === "detail" && <><div className="inline-actions">{!action.detail.visit.canceledAt && <><button data-modal-initial onClick={() => start({ kind: "edit", detail: action.detail })}>時刻を訂正</button><button className="danger-button" onClick={() => start({ kind: "cancel", detail: action.detail })}>記録を取り消す</button></>}<button className="secondary" disabled={opening} onClick={() => void openDetail(action.detail.visit.id)}>詳細を読み直す</button></div><h3>変更履歴</h3>{action.detail.revisions.length ? <ol className="revision-list">{action.detail.revisions.map((revision) => <li key={revision.id}><p><strong>{revision.actorName ?? "削除済みの管理者"}</strong> · {facilityTime(revision.createdAt, action.detail.timeZone)}</p><p className="revision-reason">{revision.reason}</p><dl><dt>変更前</dt><dd>{"state" in revision.before ? "記録なし（新規追加）" : `${facilityTime(revision.before.enteredAt, action.detail.timeZone)} → ${facilityTime(revision.before.exitedAt, action.detail.timeZone)} · ${visitStatus(revision.before)}`}</dd><dt>変更後</dt><dd>{facilityTime(revision.after.enteredAt, action.detail.timeZone)} → {facilityTime(revision.after.exitedAt, action.detail.timeZone)} · {visitStatus(revision.after)}</dd></dl></li>)}</ol> : <p className="muted">管理者による変更はありません。</p>}{action.detail.nextCursor && <button className="secondary" disabled={busy} onClick={() => void moreRevisions()}>以前の変更履歴を表示</button>}<div className="inline-actions"><button className="secondary" onClick={() => setAction(null)}>閉じる</button></div></>}
      {action && important && <form onSubmit={(event) => void submit(event)}><fieldset disabled={busy || blocked}>
        {action.kind === "manual" && <div><label htmlFor="manual-person-query">利用者を名前・所属で探す</label><div className="person-picker-search"><input id="manual-person-query" value={personQuery} maxLength={100} onChange={(event) => setPersonQuery(event.target.value)} /><button type="button" className="secondary" onClick={() => void searchPeople()}>利用者を検索</button></div>{selected && <p className="notice" role="status">選択中：{selected.displayName}</p>}{people.length > 0 && <ul className="person-picker">{people.map((person) => <li key={person.id}><button type="button" className="secondary" aria-pressed={selected?.id === person.id} onClick={() => setSelected(person)}>{person.displayName}<span>{person.affiliation ?? "所属なし"}{person.code ? ` · ${person.code}` : ""}</span></button></li>)}</ul>}<p className="field-help">最大20人を表示します。名前や所属で絞って選択してください。</p></div>}
        {(action.kind === "manual" || action.kind === "edit") && <><label htmlFor="visit-entered">入室日時</label><input data-modal-initial={action.kind === "edit" ? true : undefined} id="visit-entered" type="datetime-local" step="0.001" required value={entered} onChange={(event) => setEntered(event.target.value)} /><label htmlFor="visit-exited">退室日時<span className="field-optional">未退室なら空欄</span></label><input id="visit-exited" type="datetime-local" step="0.001" value={exited} onChange={(event) => setExited(event.target.value)} /><p className="field-help">施設の時刻：{action.kind === "edit" ? action.detail.timeZone : timeZone}。未来の日時・逆転・他の記録との重複は保存できません。</p></>}
        {action.kind !== "csv" && <><label htmlFor="visit-reason">変更理由</label><textarea data-modal-initial={action.kind === "cancel" ? true : undefined} id="visit-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={500} rows={3} /></>}
        {action.kind === "csv" && <dl className="csv-conditions"><dt>入室日の期間</dt><dd>{action.query.from || "指定なし"} ～ {action.query.to || "指定なし"}（{timeZone}）</dd><dt>名前・所属</dt><dd>{action.query.q || "指定なし"}{action.query.personId && " · 選択した利用者のみ"}</dd><dt>状態</dt><dd>{{ all: "有効な記録すべて", inside: "記録上の在室中", completed: "退室済み", canceled: "取消済み" }[action.query.status]}</dd><dt>所属の絞り込み</dt><dd>{action.query.affiliation || "指定なし"}</dd><dt>記録方法・訂正</dt><dd>{{ all: "すべての記録方法", MANUAL: "手動追加", RECEPTION: "QR受付" }[action.query.source]} · {{ all: "訂正の有無すべて", true: "訂正あり", false: "訂正なし" }[action.query.corrected]}</dd></dl>}
        <div className="reauth-area">{identity?.recentAuth ? <p className="field-help">本人確認済みです。確認から5分を過ぎた場合は、もう一度本人確認が必要です。</p> : <><p>この操作にはパスキーでの本人確認が必要です。</p><button type="button" className="secondary" onClick={() => void authenticate()}>パスキーで本人確認</button></>}</div>
        <div className="inline-actions"><button className="secondary" type="button" onClick={() => setAction(null)}>キャンセル</button><button data-modal-initial={action.kind === "csv" ? true : undefined} className={action.kind === "cancel" ? "danger-button" : undefined} disabled={!identity?.recentAuth} type="submit">{busy ? "処理中…" : action.kind === "csv" ? "CSVをダウンロード" : action.kind === "cancel" ? "この記録を取り消す" : action.kind === "manual" ? "記録を追加" : "訂正を保存"}</button></div>
      </fieldset></form>}
      {blocked && <div className="inline-actions">{action && "detail" in action && <button className="secondary" disabled={opening} onClick={() => void openDetail(action.detail.visit.id)}>最新の記録を読み直す</button>}<button className="secondary" onClick={() => { setAction(null); records.refresh(); }}>閉じて履歴を確認</button></div>}
    </Modal>
  </section>;
}
