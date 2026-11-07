"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { devicesResponseSchema, securityResponseSchema, invitationResponseSchema, recoveryCodesResponseSchema, mutationResponseSchema, type SecurityResponse, type DeviceSummary, type DevicesResponse } from "@mame/contracts";
import { api, ApiFailure, authClient, dateLabel, requirePasskey } from "./client-api";
import { Modal } from "./modal";

type ManagedPasskey = SecurityResponse["passkeys"][number];
type ManagedAdmin = SecurityResponse["admins"][number];
type Action = { kind: "add" | "recovery" | "invite" } | { kind: "rename" | "revoke"; passkey: ManagedPasskey } | { kind: "approve" | "reject" | "device-revoke" | "device-rename"; device: DeviceSummary } | { kind: "disable" | "admin-rename"; admin: ManagedAdmin } | { kind: "codes"; codes: string[] } | { kind: "invitation"; code: string; expiresAt: string };
const deviceLabels = { PENDING: "承認待ち", APPROVED: "承認済み", REJECTED: "拒否", REVOKED: "失効", EXPIRED: "期限切れ" };

export function SettingsPanel() {
  const [security, setSecurity] = useState<SecurityResponse | null>(null);
  const [devices, setDevices] = useState<DevicesResponse>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [adminChanged, setAdminChanged] = useState(false);
  const [message, setMessage] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("30");
  const notice = useRef<HTMLDivElement>(null);

  async function load() {
    const [identity, registered] = await Promise.all([
      api("/api/admin/security", securityResponseSchema), api("/api/admin/devices", devicesResponseSchema),
    ]);
    setSecurity(identity); setDevices(registered); setAdminChanged(false);
  }

  useEffect(() => {
    let active = true;
    void Promise.all([api("/api/admin/security", securityResponseSchema), api("/api/admin/devices", devicesResponseSchema)])
      .then(([identity, registered]) => { if (active) { setSecurity(identity); setDevices(registered); } })
      .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : "設定を読み込めませんでした。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function open(next: Action) {
    const initialName = next.kind === "rename" ? next.passkey.name ?? "" : next.kind === "admin-rename" ? next.admin.name : next.kind === "device-rename" ? next.device.name : "";
    setName(initialName);
    setEmail(""); setDays("30"); setModalMessage(adminChanged ? "ログインしている管理者が変わりました。キャンセルして、一覧を更新してからやり直してください。" : ""); setAction(next);
  }

  async function currentIdentity(expectedUserId: string) {
    const identity = await api("/api/admin/security", securityResponseSchema);
    // 別タブで管理者が切り替わった場合、前の管理者の確認画面から変更を実行しない。
    if (identity.currentUserId !== expectedUserId) {
      setAdminChanged(true);
      throw new Error("ログインしている管理者が変わりました。キャンセルして、一覧を更新してからやり直してください。");
    }
    setSecurity(identity);
    return identity;
  }

  async function authenticate(expectedUserId: string) {
    setAuthenticating(true);
    try {
      requirePasskey();
      const result = await authClient.signIn.passkey();
      if (result.error) throw new Error("本人確認は完了していません。パスキーを選び直して、もう一度お試しください。");
      const identity = await currentIdentity(expectedUserId);
      if (!identity.recentAuth) throw new Error("本人確認の期限が切れました。もう一度お試しください。");
    } finally { setAuthenticating(false); }
  }

  async function perform(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || adminChanged || !security || !action || action.kind === "codes" || action.kind === "invitation") return;
    setBusy(true); setModalMessage(""); setMessage("");
    try {
      // 直近のパスキー認証は再利用する。操作時に再照合し、画面表示だけで有効と判断しない。
      const identity = await currentIdentity(security.currentUserId);
      // 表示名だけの変更は通常の管理者権限で行い、パスキーや受付資格を変更しない。
      if (action.kind !== "admin-rename" && action.kind !== "device-rename" && !identity.recentAuth) {
        if (security.recentAuth) {
          setModalMessage("本人確認の有効時間が過ぎました。入力内容を確認し、もう一度実行してください。");
          return;
        }
        await authenticate(security.currentUserId);
      }
      switch (action.kind) {
        case "add": {
          await api("/api/admin/passkeys/begin", mutationResponseSchema, {});
          const result = await authClient.passkey.addPasskey({ name: name.trim() || "追加のパスキー", createSession: true });
          if (result.error) throw new Error("パスキーの追加は完了していません。端末の案内に従って、もう一度お試しください。");
          break;
        }
        case "rename": await api(`/api/admin/passkeys/${encodeURIComponent(action.passkey.id)}/name`, mutationResponseSchema, { name }); break;
        case "admin-rename": await api(`/api/admin/administrators/${encodeURIComponent(action.admin.id)}/name`, mutationResponseSchema, { name }); break;
        case "device-rename": await api(`/api/admin/devices/${encodeURIComponent(action.device.id)}/name`, mutationResponseSchema, { name }); break;
        case "revoke": await api(`/api/admin/passkeys/${encodeURIComponent(action.passkey.id)}/revoke`, mutationResponseSchema, {}); break;
        case "disable": await api(`/api/admin/administrators/${encodeURIComponent(action.admin.id)}/disable`, mutationResponseSchema, {}); break;
        case "recovery": {
          const result = await api("/api/admin/recovery-codes", recoveryCodesResponseSchema, {});
          setAction({ kind: "codes", codes: result.codes });
          setSecurity((current) => current ? { ...current, recoveryConfigured: true } : current); return;
        }
        case "invite": {
          const result = await api("/api/admin/invitations", invitationResponseSchema, { name, email });
          setAction({ kind: "invitation", ...result });
          return;
        }
        case "approve": await api(`/api/admin/devices/${action.device.id}/approve`, mutationResponseSchema, { expiresInDays: Number(days) }); break;
        case "reject": await api(`/api/admin/devices/${action.device.id}/reject`, mutationResponseSchema, {}); break;
        case "device-revoke": await api(`/api/admin/devices/${action.device.id}/revoke`, mutationResponseSchema, {}); break;
      }
      setAction(null); setMessage("変更を保存しました。");
      await load().catch(() => setMessage("変更は保存しました。一覧を更新できなかったため、通信を確認して状態を再確認してください。"));
      requestAnimationFrame(() => notice.current?.focus());
    } catch (error) {
      if (error instanceof ApiFailure && error.code === "REAUTH_REQUIRED") {
        // 照合後の期限切れは自動再送せず、入力を保って次の明示操作で本人確認する。
        setSecurity((current) => current ? { ...current, recentAuth: false } : current);
        setModalMessage("本人確認の有効時間が過ぎました。入力内容を確認し、もう一度実行してください。");
      } else { setModalMessage(error instanceof Error ? error.message : "操作を完了できませんでした。"); }
    }
    finally { setBusy(false); }
  }

  async function refresh() {
    setBusy(true); setMessage("");
    try { await load(); setMessage("最新の状態を表示しています。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "状態を確認できませんでした。"); }
    finally { setBusy(false); }
    requestAnimationFrame(() => notice.current?.focus());
  }

  const dialog = describeAction(action);
  const needsAuthentication = action?.kind !== "admin-rename" && action?.kind !== "device-rename" && !security?.recentAuth;
  return <section aria-busy={loading || busy}>
    <div className="workspace-heading"><Link href="/">ホームへ</Link><h1>管理者の設定</h1><p className="muted">管理者のパスキーや、QR受付に使う端末を管理する画面です。名簿・記録を管理する操作も、管理者だけが行います。</p><p className="field-help">管理者名・端末名だけの変更は、ログイン中ならそのまま保存できます。パスキーの変更や端末の承認などは、本人確認から5分を過ぎた場合だけ再確認します。</p></div>
    {message && <div ref={notice} tabIndex={-1} role="status" className="notice">{message}</div>}
    {loading ? <p role="status">設定を読み込んでいます…</p> : !security ? <div className="settings-section"><p>管理者としてログインした後、この画面を開いてください。</p><div className="inline-actions"><Link className="text-link" href="/">ログイン画面へ</Link><button className="secondary" disabled={busy} onClick={() => void refresh()}>状態を再確認</button></div></div> : <>
      <section className="settings-section" aria-labelledby="passkeys-title">
        <div className="section-heading"><div><h2 id="passkeys-title">パスキー</h2><p className="muted">個人で使用する端末に20件まで登録できます。最後のパスキーは失効できません。</p></div><button disabled={busy || security.passkeys.length >= 20} onClick={() => open({ kind: "add" })}>パスキーを追加</button></div>
        <ul className="item-list">{security.passkeys.map((passkey) => <li key={passkey.id}><h3>{passkey.name ?? "名前のないパスキー"}</h3><p className="item-meta">登録：{dateLabel(passkey.createdAt)}<br />最終利用：{dateLabel(passkey.lastUsedAt)}</p><div className="inline-actions"><button className="secondary" disabled={busy} onClick={() => open({ kind: "rename", passkey })}>名前を変更<span className="visually-hidden">：{passkey.name ?? "名前のないパスキー"}</span></button><button className="danger-button" disabled={busy || security.passkeys.length <= 1} onClick={() => open({ kind: "revoke", passkey })}>失効<span className="visually-hidden">：{passkey.name ?? "名前のないパスキー"}</span></button></div></li>)}</ul>
      </section>
      <section className="settings-section" aria-labelledby="recovery-title"><h2 id="recovery-title">復旧コード</h2><p>{security.recoveryConfigured ? "復旧コードは発行済みです。パスキーを使えない場合に備え、端末とは別の安全な場所へ保管してください。" : "復旧コードがまだありません。パスキーを使えない場合に備えて発行してください。"}</p><button className="secondary" disabled={busy} onClick={() => open({ kind: "recovery" })}>{security.recoveryConfigured ? "復旧コードを再発行" : "復旧コードを発行"}</button></section>
      <section className="settings-section" aria-labelledby="administrators-title">
        <div className="section-heading"><div><h2 id="administrators-title">管理者</h2><p className="muted">招待コードは、登録する本人に安全な方法で渡してください。</p></div><button className="secondary" disabled={busy} onClick={() => open({ kind: "invite" })}>管理者を招待</button></div>
        <ul className="item-list">{security.admins.map((admin) => <li key={admin.id}><h3>{admin.name}<span className="small-label">{admin.status === "ACTIVE" ? "有効" : "停止"}</span></h3><p className="item-meta">{admin.email}<span className="small-label">{admin.emailVerified ? "確認済み" : "未確認"}</span></p><div className="inline-actions"><button className="secondary" disabled={busy} onClick={() => open({ kind: "admin-rename", admin })}>名前を変更<span className="visually-hidden">：{admin.name}</span></button>{admin.status === "ACTIVE" && <button className="danger-button" disabled={busy || (!security.adminsNextCursor && security.admins.filter((item) => item.status === "ACTIVE").length <= 1)} onClick={() => open({ kind: "disable", admin })}>管理者を停止<span className="visually-hidden">：{admin.name}</span></button>}</div></li>)}</ul>
        {security.adminsNextCursor && <button className="secondary" disabled={busy} onClick={() => void (async () => {
          setBusy(true); setMessage("");
          try {
            const next = await api(`/api/admin/security?adminsCursor=${encodeURIComponent(security.adminsNextCursor!)}`, securityResponseSchema);
            setSecurity({ ...next, admins: [...security.admins, ...next.admins] });
          } catch (error) { setMessage(error instanceof Error ? error.message : "次の管理者を読み込めませんでした。"); }
          finally { setBusy(false); }
        })()}>次の管理者を表示</button>}
      </section>
      <section className="settings-section" aria-labelledby="devices-title"><div className="section-heading"><div><h2 id="devices-title">QR受付に使う端末</h2><p className="muted">入口に置き、利用者のQRコードを読み取って入退出を記録するスマホ・タブレットです。QR受付用の登録では、名簿や管理者の設定は操作できません。</p><p className="field-help">受付に使う端末で、このサイトの<Link className="text-link" href="/device">QR受付に使う端末を登録</Link>を開いて申請します。ここでは申請内容を確認して承認します。QRを読み取る画面は準備中です。</p></div><button className="secondary" disabled={busy} onClick={() => void refresh()}>一覧を更新</button></div>{devices.items.length === 0 ? <p>登録・申請された端末はありません。</p> : <ul className="item-list">{devices.items.map((device) => <li key={device.id}><h3>{device.name} <span className="status-label">{deviceLabels[device.status]}</span></h3>{device.status === "PENDING" && <p className="item-meta">確認コード：<strong>{device.confirmationCode}</strong><br />申請期限：{dateLabel(device.applicationExpiresAt)}</p>}<p className="item-meta">有効期限：{dateLabel(device.expiresAt)}<br />最終利用：{dateLabel(device.lastUsedAt)}</p><div className="inline-actions"><button className="secondary" disabled={busy} onClick={() => open({ kind: "device-rename", device })}>名前を変更<span className="visually-hidden">：{device.name}</span></button>{device.status === "PENDING" && <><button disabled={busy} onClick={() => open({ kind: "approve", device })}>承認<span className="visually-hidden">：{device.name}</span></button><button className="secondary" disabled={busy} onClick={() => open({ kind: "reject", device })}>拒否<span className="visually-hidden">：{device.name}</span></button></>}{device.status === "APPROVED" && <button className="danger-button" disabled={busy} onClick={() => open({ kind: "device-revoke", device })}>失効<span className="visually-hidden">：{device.name}</span></button>}</div></li>)}</ul>}{devices.nextCursor && <div className="inline-actions"><button className="secondary" disabled={busy} onClick={() => void (async () => {
        setBusy(true); setMessage("");
        try { const next = await api(`/api/admin/devices?cursor=${encodeURIComponent(devices.nextCursor!)}`, devicesResponseSchema); setDevices({ items: [...devices.items, ...next.items], nextCursor: next.nextCursor }); }
        catch (error) { setMessage(error instanceof Error ? error.message : "次の端末を読み込めませんでした。"); }
        finally { setBusy(false); }
      })()}>続きを表示</button></div>}</section>
    </>}
    <Modal open={action !== null} title={dialog.title} description={dialog.description} busy={busy} onClose={() => { if (!busy) setAction(null); }}>
      {action?.kind === "codes" || action?.kind === "invitation" ? <>
        {action.kind === "codes" ? <ul className="recovery-codes">{action.codes.map((code) => <li key={code}>{code}</li>)}</ul> : <><p className="code-value">{action.code}</p><p className="field-help">有効期限：{dateLabel(action.expiresAt)}</p><p>招待した方に、このサイトの「招待された管理者の登録」画面でコードを入力してもらってください。</p></>}
        <p className="field-help">閉じると再表示できません。保存・受け渡しが終わってから閉じてください。</p>
        <div className="inline-actions"><button data-modal-initial onClick={() => setAction(null)}>保存したので閉じる</button></div>
      </> : <form onSubmit={(event) => void perform(event)}>
        {(action?.kind === "add" || action?.kind === "rename" || action?.kind === "invite" || action?.kind === "admin-rename" || action?.kind === "device-rename") && <><label htmlFor="management-name">{action.kind === "invite" ? "招待する方の表示名" : action.kind === "admin-rename" ? "管理者の名前" : action.kind === "device-rename" ? "端末名" : "パスキーの名前"}</label><input id="management-name" value={name} onChange={(event) => setName(event.target.value)} required={action.kind !== "add"} maxLength={100} disabled={busy} /></>}
        {action?.kind === "invite" && <><label htmlFor="invitation-email">招待する方のメールアドレス</label><input id="invitation-email" type="email" autoComplete="off" required value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} disabled={busy} /><p className="field-help">確認メールは送信されません。登録する方の識別に使用します。</p></>}
        {action?.kind === "approve" && <><p className="code-value">{action.device.confirmationCode}</p><p>受付端末の画面に、上と同じ確認コードが表示されていることを確認してください。</p><label htmlFor="device-days">有効期間（日）</label><input id="device-days" type="number" required min={1} max={90} value={days} onChange={(event) => setDays(event.target.value)} disabled={busy} /></>}
        {needsAuthentication && <p className="field-help">本人確認から時間がたっているため、パスキーで再確認してから実行します。</p>}
        {modalMessage && <div role="alert" className="notice error">{modalMessage}</div>}
        {busy && <p role="status" className="field-help">{authenticating ? "端末の案内で本人確認を行っています。完了までお待ちください。" : "処理しています。完了までお待ちください。"}</p>}
        <div className="inline-actions"><button className="secondary" type="button" data-modal-initial disabled={busy} onClick={() => setAction(null)}>キャンセル</button><button type="submit" disabled={busy || adminChanged}>{busy ? "確認しています…" : `${needsAuthentication ? "本人確認して" : ""}${dialog.confirm}`}</button></div>
      </form>}
    </Modal>
  </section>;
}

function describeAction(action: Action | null) {
  if (!action) return { title: "確認", description: "", confirm: "実行" };
  switch (action.kind) {
    case "add": return { title: "パスキーを追加", description: "新しく使う端末や認証方法に、管理者のパスキーを登録します。", confirm: "追加" };
    case "rename": return { title: "パスキーの名前を変更", description: `「${action.passkey.name ?? "名前のないパスキー"}」の表示名を変更します。`, confirm: "保存" };
    case "admin-rename": return { title: "管理者の名前を変更", description: `「${action.admin.name}」の表示名だけを変更します。メールアドレスやログイン方法はそのままです。`, confirm: "保存" };
    case "device-rename": return { title: "QR受付端末の名前を変更", description: `「${action.device.name}」の端末名だけを変更します。登録や承認の状態、有効期限はそのままです。`, confirm: "保存" };
    case "revoke": return { title: "パスキーを失効", description: `「${action.passkey.name ?? "名前のないパスキー"}」ではログインできなくなります。別のパスキーが使えることを確認してください。`, confirm: "失効" };
    case "recovery": return { title: "復旧コードを発行", description: "これまでの復旧コードはすべて使えなくなります。新しいコードは次の画面で一度だけ表示します。安全な場所に保存してください。", confirm: "発行" };
    case "invite": return { title: "管理者を招待", description: "招待した方は、利用者や記録を管理できるようになります。本人の表示名とメールアドレスを入力してください。", confirm: "招待" };
    case "disable": return { title: "管理者を停止", description: `「${action.admin.name}」のログインと、使用中のセッションを無効にします。最後の有効管理者は停止できません。`, confirm: "停止" };
    case "approve": return { title: "受付端末を承認", description: `「${action.device.name}」でQRコードを読み取り、入退出を記録できるようにします。受付に使う端末の画面と確認コードを照合してください。`, confirm: "承認" };
    case "reject": return { title: "端末の申請を拒否", description: `「${action.device.name}」の申請を拒否します。この申請から受付を開始できなくなります。`, confirm: "拒否" };
    case "device-revoke": return { title: "受付端末を失効", description: `「${action.device.name}」は次の操作から記録できなくなります。過去の記録は残ります。`, confirm: "失効" };
    case "codes": return { title: "復旧コードを保存", description: "このコードは一度だけ表示します。パスキーが使えなくなったときに備え、端末とは別の安全な場所に保存してください。", confirm: "確認" };
    case "invitation": return { title: "招待コードを控える", description: "招待コードは一度だけ表示します。登録する本人だけに、安全な方法で渡してください。", confirm: "確認" };
  }
}
