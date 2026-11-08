"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import {
  peopleResponseSchema, personDetailSchema, personInputSchema, qrIssueResponseSchema, securityResponseSchema,
  type PersonDetail, type SecurityResponse,
} from "@mame/contracts";
import type { z } from "zod";
import { api, ApiFailure, authClient, requirePasskey } from "./client-api";
import { Modal } from "./modal";
import { Brand } from "./brand";

type People = z.infer<typeof peopleResponseSchema>;
type PersonRow = People["items"][number];
type Fields = { displayName: string; phoneticName: string; affiliation: string; code: string };
type Action = { kind: "create" } | { kind: "edit" | "issue" | "revoke" | "status"; person: PersonDetail } | { kind: "qr"; person: PersonDetail; image: string };
const emptyFields: Fields = { displayName: "", phoneticName: "", affiliation: "", code: "" };
const fieldDefinitions = [
  { key: "displayName", label: "表示名", maximum: 100, required: true },
  { key: "phoneticName", label: "ふりがな", maximum: 100, required: false },
  { key: "affiliation", label: "所属", maximum: 100, required: false },
  { key: "code", label: "利用者コード", maximum: 64, required: false },
] as const;
const statusLabels = { ACTIVE: "有効", SUSPENDED: "停止中", DELETED: "削除済み" };

function listPath(query: { q: string; status: string }, cursor?: string | null) {
  const params = new URLSearchParams({ limit: "20" });
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (cursor) params.set("cursor", cursor);
  return `/api/admin/people?${params.toString()}`;
}

export function PeoplePanel() {
  const [people, setPeople] = useState<People>({ items: [], nextCursor: null });
  const [security, setSecurity] = useState<SecurityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [adminChanged, setAdminChanged] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState({ q: "", status: "" });
  const [action, setAction] = useState<Action | null>(null);
  const [fields, setFields] = useState<Fields>(emptyFields);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [modalMessage, setModalMessage] = useState("");
  const [message, setMessage] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [created, setCreated] = useState<PersonDetail | null>(null);
  const requestNumber = useRef(0);
  const mounted = useRef(false);
  const notice = useRef<HTMLDivElement>(null);
  const modalOpener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const initialRequest = ++requestNumber.current;
    void Promise.all([api(listPath({ q: "", status: "" }), peopleResponseSchema), api("/api/admin/security", securityResponseSchema)])
      .then(([rows, identity]) => { if (active && initialRequest === requestNumber.current) { setPeople(rows); setSecurity(identity); setLoaded(true); } })
      .catch((error: unknown) => { if (active && initialRequest === requestNumber.current) { setNoticeError(true); setMessage(error instanceof Error ? error.message : "利用者を読み込めませんでした。"); } })
      .finally(() => { if (active && initialRequest === requestNumber.current) setLoading(false); });
    return () => { active = false; mounted.current = false; requestNumber.current = -1; };
  }, []);

  async function load(nextQuery = query, append = false) {
    if (!mounted.current) return;
    const number = ++requestNumber.current;
    setLoading(true);
    try {
      const rows = await api(listPath(nextQuery, append ? people.nextCursor : null), peopleResponseSchema);
      if (number !== requestNumber.current) return;
      setPeople((current) => append ? { items: [...current.items, ...rows.items], nextCursor: rows.nextCursor } : rows);
      setQuery(nextQuery); setLoaded(true);
    } finally { if (number === requestNumber.current) setLoading(false); }
  }

  async function search(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setMessage(""); setCreated(null);
    try {
      if (!security) setSecurity(await api("/api/admin/security", securityResponseSchema));
      await load({ q: q.trim(), status });
    } catch (error) { setNoticeError(true); setMessage(error instanceof Error ? error.message : "利用者を読み込めませんでした。"); }
  }

  function rememberOpener() {
    const element = document.activeElement;
    if (element instanceof HTMLElement) modalOpener.current = element;
  }

  function showAction(next: Action, captureOpener = true) {
    // 発行確認からQR表示や失効確認へ進んでも、最初に押した一覧のボタンを保持する。
    if (captureOpener && action === null) rememberOpener();
    setAction(next); setModalMessage(""); setFieldErrors({}); setBlocked(false);
    setFields(next.kind === "edit" ? {
      displayName: next.person.displayName, phoneticName: next.person.phoneticName ?? "", affiliation: next.person.affiliation ?? "", code: next.person.code ?? "",
    } : emptyFields);
  }

  async function open(kind: "edit" | "issue" | "status", person: Pick<PersonRow, "id">) {
    // 読込中にボタンが無効になる前の位置を保存し、キャンセル後に操作を続けられるようにする。
    rememberOpener();
    setBusy(true); setMessage(""); setCreated(null);
    try { showAction({ kind, person: await api(`/api/admin/people/${person.id}`, personDetailSchema) }, false); }
    catch (error) { setNoticeError(true); setMessage(error instanceof Error ? error.message : "利用者の状態を確認できませんでした。"); }
    finally { setBusy(false); }
  }

  async function identityBeforeAction() {
    if (!security) throw new Error("ログイン状態を確認して、画面を開き直してください。");
    const identity = await api("/api/admin/security", securityResponseSchema);
    // 別タブで管理者が変わったときは、前の人の確認画面をそのまま実行しない。
    if (identity.currentUserId !== security.currentUserId) {
      setAdminChanged(true);
      throw new Error("ログインしている管理者が変わりました。キャンセルして、画面を開き直してください。");
    }
    setSecurity(identity);
    return identity;
  }

  async function perform(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || action.kind === "qr" || busy || adminChanged || blocked) return;
    setBusy(true); setModalMessage(""); setFieldErrors({});
    try {
      const identity = await identityBeforeAction();
      const important = action.kind === "issue" || action.kind === "revoke" || action.kind === "status";
      if (important && !identity.recentAuth) {
        // 画面を開いた後の期限切れでは自動的に認証を始めず、次の明示操作を待つ。
        if (security?.recentAuth) { setModalMessage("本人確認の有効時間が過ぎました。内容を確認し、もう一度実行してください。"); return; }
        setAuthenticating(true); requirePasskey();
        const result = await authClient.signIn.passkey();
        if (result.error) throw new Error("本人確認は完了していません。パスキーを選び直してください。");
        if (!(await identityBeforeAction()).recentAuth) throw new Error("本人確認を確認できませんでした。もう一度お試しください。");
        setAuthenticating(false);
      }
      if (action.kind === "create" || action.kind === "edit") {
        const input = personInputSchema.safeParse(fields);
        if (!input.success) {
          const errors: Partial<Record<keyof Fields, string>> = {};
          for (const issue of input.error.issues) {
            const key = issue.path[0] as keyof Fields;
            if (key in fields) errors[key] = key === "displayName" ? "表示名を1〜100文字で入力してください。" : "文字数と入力内容を確認してください。";
          }
          setFieldErrors(errors); setModalMessage("入力内容を確認してください。"); return;
        }
        if (action.kind === "create") {
          const result = await api("/api/admin/people", personDetailSchema, input.data);
          setCreated(result); setMessage("利用者を登録しました。続けてQRコードを発行できます。");
        } else {
          await api(`/api/admin/people/${action.person.id}`, personDetailSchema, { ...input.data, expectedVersion: action.person.version }, "PATCH");
          setCreated(null); setMessage("利用者の情報を保存しました。");
        }
      } else if (action.kind === "status") {
        await api(`/api/admin/people/${action.person.id}/status`, personDetailSchema, { status: action.person.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE", expectedVersion: action.person.version }, "PUT");
        setCreated(null); setMessage(action.person.status === "ACTIVE" ? "利用を停止しました。以前のQRコードは使えません。" : "利用を再開しました。新しいQRコードを発行してください。");
      } else if (action.kind === "revoke") {
        await api(`/api/admin/people/${action.person.id}/qr-credentials/current`, personDetailSchema, { expectedVersion: action.person.version }, "DELETE");
        setCreated(null); setMessage("QRコードを失効しました。過去の入退出記録は保持しています。");
      } else {
        const issued = await api(`/api/admin/people/${action.person.id}/qr-credentials`, qrIssueResponseSchema, { expectedVersion: action.person.version });
        if (issued.personId !== action.person.id) { setBlocked(true); throw new Error("発行結果の対象を確認できませんでした。閉じて利用者の状態を確認してください。"); }
        const updated = { ...action.person, qrActive: true, version: issued.version };
        // 生値をDOMの文字列や永続ストレージに置かず、発行した画面内だけで画像へ変換する。
        try {
          const image = await QRCode.toDataURL(issued.qr, { errorCorrectionLevel: "M", margin: 4, width: 640 });
          setAction({ kind: "qr", person: updated, image }); setCreated(null);
        } catch {
          setAction({ kind: "issue", person: updated });
          setBlocked(true); setModalMessage("発行は完了しましたが、QR画像を表示できませんでした。閉じて最新の状態を確認し、もう一度発行してください。再発行すると今回のQRは使えなくなります。");
        }
        return;
      }
      setAction(null); setNoticeError(false);
      await load().catch(() => { setNoticeError(true); setMessage("変更は保存しました。一覧を更新できなかったため、接続を確認して一覧を再確認してください。"); });
      requestAnimationFrame(() => notice.current?.focus());
    } catch (error) {
      if (error instanceof ApiFailure && error.code === "REAUTH_REQUIRED") {
        setSecurity((current) => current ? { ...current, recentAuth: false } : current);
        setModalMessage("本人確認の有効時間が過ぎました。内容を確認して、もう一度実行してください。");
      } else {
        if (error instanceof ApiFailure && error.code === "VERSION_CONFLICT") setBlocked(true);
        setModalMessage(error instanceof Error ? error.message : "操作を完了できませんでした。状態を確認してください。");
      }
    } finally { setBusy(false); setAuthenticating(false); }
  }

  const description = describe(action);
  const needsAuthentication = action && ["issue", "revoke", "status"].includes(action.kind) && !security?.recentAuth;
  return <section aria-busy={loading || busy}>
    <div className="page-heading"><div><h1>利用者</h1><p className="muted">利用者を登録し、受付で使うQRコードを発行します。</p></div><button disabled={busy || !security} onClick={() => showAction({ kind: "create" })}>利用者を登録</button></div>
    {message && <div ref={notice} tabIndex={-1} className={`notice ${noticeError ? "error" : ""}`} role={noticeError ? "alert" : "status"}>{message}{created && <div className="inline-actions"><button className="secondary" disabled={busy} onClick={() => void open("issue", created)}>登録した方のQRを発行</button></div>}</div>}
    <form className="people-search content-panel" onSubmit={(event) => void search(event)}>
      <div><label htmlFor="people-query">利用者を検索</label><input id="people-query" type="search" value={q} maxLength={100} onChange={(event) => setQ(event.target.value)} placeholder="名前・ふりがな・所属・コード" disabled={busy} /></div>
      <div><label htmlFor="people-status">状態</label><select id="people-status" value={status} onChange={(event) => setStatus(event.target.value)} disabled={busy}><option value="">すべて</option><option value="ACTIVE">有効</option><option value="SUSPENDED">停止中</option><option value="DELETED">削除済み</option></select></div>
      <button type="submit" className="secondary" disabled={loading || busy}>検索</button>
    </form>
    <section className="content-panel" aria-labelledby="people-list-title">
      <div className="section-heading"><div><h2 id="people-list-title">利用者一覧</h2><p className="field-help">同じ名前の方がいる場合は、所属や利用者コードで見分けてください。</p></div><button className="secondary" disabled={loading || busy} onClick={() => void search()}>一覧を更新</button></div>
      {loading && <p role="status">利用者を読み込んでいます…</p>}
      {loaded && people.items.length === 0 && !loading && <div className="empty-state"><p>{query.q || query.status ? "条件に一致する利用者はいません。" : "利用者はまだ登録されていません。"}</p><p className="field-help">{query.q || query.status ? "検索する文字や状態を変更して、もう一度お試しください。" : "「利用者を登録」から、表示名を入力して登録してください。"}</p></div>}
      {!loaded && !loading && <p>一覧を表示できませんでした。「一覧を更新」から再確認してください。</p>}
      <ul className="people-list">{people.items.map((person) => <li key={person.id}>
        <div className="person-summary"><h3>{person.displayName}<span className={`status-label ${person.status !== "ACTIVE" ? "status-neutral" : ""}`}>{statusLabels[person.status]}</span></h3>{person.phoneticName && <p className="item-meta">{person.phoneticName}</p>}<p className="item-meta">所属：{person.affiliation || "未設定"}<br />利用者コード：{person.code || "未設定"}</p></div>
        {person.status !== "DELETED" && <div className="inline-actions"><button className="secondary" disabled={busy || loading} onClick={() => void open("edit", person)}>編集<span className="visually-hidden">：{person.displayName}</span></button>{person.status === "ACTIVE" && <button className="secondary" disabled={busy || loading} onClick={() => void open("issue", person)}>QRコード<span className="visually-hidden">：{person.displayName}</span></button>}<button className={person.status === "ACTIVE" ? "text-button danger-text" : "secondary"} disabled={busy || loading} onClick={() => void open("status", person)}>{person.status === "ACTIVE" ? "利用停止" : "利用再開"}<span className="visually-hidden">：{person.displayName}</span></button></div>}
      </li>)}</ul>
      {people.nextCursor && <div className="inline-actions"><button className="secondary" disabled={loading || busy} onClick={() => void load(query, true).catch((error: unknown) => { setNoticeError(true); setMessage(error instanceof Error ? error.message : "続きを読み込めませんでした。"); })}>続きを表示</button></div>}
    </section>
    <Modal open={action !== null} title={description.title} description={description.message} busy={busy} returnFocusRef={modalOpener} onClose={() => { if (!busy) setAction(null); }}>
      {action?.kind === "qr" ? <>
        <div className="qr-print-area"><div className="qr-card-brand"><Brand /></div><h3>{action.person.displayName}</h3><Image unoptimized src={action.image} width={320} height={320} alt={`${action.person.displayName}さんの受付用QRコード`} className="issued-qr" /><p>受付でこのQRコードを見せてください。</p></div>
        <p className="field-help">この画面を閉じると、同じQRは再表示できません。画像の保存か印刷を済ませてください。コピーや貸し借りにより、他の人も利用できるため大切に保管してください。</p>
        <div className="inline-actions"><a className="button-link secondary" href={action.image} download="mame-inout-qr.png">QR画像を保存</a><button className="secondary" onClick={() => window.print()}>印刷</button><button data-modal-initial onClick={() => { setAction(null); setNoticeError(false); setMessage("QRを発行しました。必要な保存や印刷が済んでいることを確認してください。"); }}>保存したので閉じる</button></div>
      </> : <form onSubmit={(event) => void perform(event)}>
        {(action?.kind === "create" || action?.kind === "edit") && <>
          {fieldDefinitions.map((field) => <div className="person-field" key={field.key}><label htmlFor={`person-${field.key}`}>{field.label}<span className="field-optional">{field.required ? "必須" : "任意"}</span></label><input id={`person-${field.key}`} value={fields[field.key]} maxLength={field.maximum} required={field.required} autoComplete="off" disabled={busy} aria-invalid={fieldErrors[field.key] ? true : undefined} aria-describedby={fieldErrors[field.key] ? `person-${field.key}-error` : undefined} onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))} />{fieldErrors[field.key] && <p id={`person-${field.key}-error`} className="field-error">{fieldErrors[field.key]}</p>}</div>)}
          <p className="field-help">利用者コードは、この施設内で重複しない番号などを任意で設定できます。</p>
        </>}
        {action?.kind === "issue" && action.person.qrActive && <div className="notice">現在のQRは再表示できません。再発行すると、以前に配った画像や紙のQRは直ちに使えなくなります。</div>}
        {needsAuthentication && <p className="field-help">本人確認から時間がたっているため、パスキーで再確認して実行します。</p>}
        {modalMessage && <div role="alert" className="notice error">{modalMessage}</div>}
        {busy && <p role="status">{authenticating ? "端末の案内で本人確認を行ってください。" : "処理しています。完了までお待ちください。"}</p>}
        <div className="inline-actions"><button type="button" data-modal-initial className="secondary" disabled={busy} onClick={() => setAction(null)}>キャンセル</button>{action?.kind === "issue" && action.person.qrActive && <button type="button" className="danger-button" disabled={busy} onClick={() => showAction({ kind: "revoke", person: action.person })}>現在のQRを失効</button>}<button type="submit" disabled={busy || blocked || adminChanged || !security}>{busy ? "処理しています…" : `${needsAuthentication ? "本人確認して" : ""}${description.confirm}`}</button></div>
      </form>}
    </Modal>
  </section>;
}

function describe(action: Action | null) {
  if (!action) return { title: "確認", message: "", confirm: "実行" };
  switch (action.kind) {
    case "create": return { title: "利用者を登録", message: "表示名を入力してください。ふりがな・所属・利用者コードは任意です。", confirm: "登録" };
    case "edit": return { title: "利用者の情報を編集", message: `「${action.person.displayName}」の情報を変更します。QRと過去の記録は保持します。`, confirm: "保存" };
    case "issue": return { title: action.person.qrActive ? "QRを再発行" : "QRを発行", message: `「${action.person.displayName}」の受付用QRを発行します。表示・保存・印刷は発行した画面でのみ行えます。`, confirm: action.person.qrActive ? "再発行" : "発行" };
    case "revoke": return { title: "QRを失効", message: `「${action.person.displayName}」の現在のQRは使えなくなります。在室状態と過去の記録は保持します。`, confirm: "失効" };
    case "status": return action.person.status === "ACTIVE" ? { title: "利用を停止", message: `「${action.person.displayName}」の受付を停止し、現在のQRを失効します。在室中の場合は先に記録の確認が必要です。`, confirm: "停止" } : { title: "利用を再開", message: `「${action.person.displayName}」の利用を再開します。以前のQRは復活しません。再開後に新しいQRを発行してください。`, confirm: "再開" };
    case "qr": return { title: "QRコードを保存", message: "画像の保存・印刷を済ませてから閉じてください。", confirm: "確認" };
  }
}
