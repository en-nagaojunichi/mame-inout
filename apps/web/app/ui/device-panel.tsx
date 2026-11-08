"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { deviceApplicationResponseSchema, deviceClaimResponseSchema, type DeviceApplicationResponse } from "@mame/contracts";
import { api, ApiFailure, dateLabel } from "./client-api";

const statusLabels = { PENDING: "承認を待っています", APPROVED: "管理者が承認しました", REJECTED: "申請は承認されませんでした", REVOKED: "登録は失効しています", EXPIRED: "有効期限が切れています" };

async function loadDeviceState() {
  try { return await api("/api/devices/current", deviceApplicationResponseSchema); }
  catch (error) { if (!(error instanceof ApiFailure && error.status === 401)) throw error; }
  return api("/api/devices/application", deviceApplicationResponseSchema);
}

export function DevicePanel() {
  const [application, setApplication] = useState<DeviceApplicationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [claimed, setClaimed] = useState(false);
  const notice = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const result = await loadDeviceState();
      setApplication(result); setClaimed(result.claimed && result.device.status === "APPROVED");
    } catch (error) {
      if (error instanceof ApiFailure && [401, 404, 410].includes(error.status)) { setApplication(null); return; }
      throw error;
    }
  }

  useEffect(() => {
    let active = true;
    void loadDeviceState()
      .then((result) => { if (active) { setApplication(result); setClaimed(result.claimed && result.device.status === "APPROVED"); } })
      .catch((error: unknown) => {
        if (active && !(error instanceof ApiFailure && [401, 404, 410].includes(error.status))) setMessage(error instanceof Error ? error.message : "状態を確認できませんでした。");
      }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "操作を完了できませんでした。"); }
    finally { setBusy(false); }
    requestAnimationFrame(() => notice.current?.focus());
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const result = await api("/api/devices/apply", deviceApplicationResponseSchema, { name });
      setApplication(result); setClaimed(false); setMessage("申請しました。確認コードを管理者に見せてください。");
    });
  }

  const device = application?.device;
  return <section aria-busy={loading || busy}>
    <div className="workspace-heading">
      <Link href="/">管理者のログインへ</Link>
      <h1>QR受付に使う端末を登録</h1>
      <p className="muted">入口に置くスマホ・タブレットを登録する画面です。利用者の個人QRを読み取り、入退出を記録する役割です。</p>
      <p>この画面では管理者のログインは不要です。管理者の個人用パスキーは、ここに登録しないでください。</p>
    </div>
    {!claimed && <>
      <ol className="step-list">
        <li>この端末で登録を申請する</li>
        <li>管理者が、このサイトの「QR受付端末」で承認する</li>
        <li>この端末で利用を開始する</li>
      </ol>
      <p className="field-help">申請したブラウザのまま、10分以内に利用開始まで進めてください。</p>
    </>}
    {message && <div ref={notice} tabIndex={-1} className="notice" role="status">{message}</div>}
    {loading ? <p role="status">登録の状態を確認しています…</p> : device ? <div className="settings-section">
      <h2>{device.name}</h2><p className="status-label">{claimed ? "このブラウザで登録済みです" : statusLabels[device.status]}</p>
      {device.status === "PENDING" && <>
        <p>管理者に、端末名と以下の確認コードを見せてください。</p>
        <p>管理者の方は、<Link className="text-link" href="/settings/devices">このサイトの「QR受付端末」</Link>で端末の一覧を更新し、名前と確認コードが同じ申請を承認してください。</p>
        <p className="code-value device-code" aria-label={`確認コード ${device.confirmationCode ?? ""}`}>{device.confirmationCode}</p>
        <p className="field-help">申請の期限：{dateLabel(device.applicationExpiresAt)}。このブラウザを閉じずにお待ちください。</p>
        <button disabled={busy} onClick={() => void run(load)}>承認の状態を確認</button>
      </>}
      {device.status === "APPROVED" && !claimed && <>
        <p>このブラウザにQR受付用の登録を保存します。申請したブラウザのまま進めてください。</p>
        <button disabled={busy} onClick={() => void run(async () => {
          await api("/api/devices/claim", deviceClaimResponseSchema, {});
          setClaimed(true); setMessage("受付端末の登録が完了しました。このブラウザを受付に使用してください。");
        })}>このブラウザで利用を開始</button>
      </>}
      {claimed && <><p>有効期限：{dateLabel(device.expiresAt)}</p><p>登録したこのブラウザでQR受付を開始できます。</p><div className="inline-actions"><Link className="text-link" href="/reception">QR受付を開く</Link><button className="secondary" disabled={busy} onClick={() => void run(load)}>登録の状態を再確認</button></div></>}
      {["REJECTED", "REVOKED", "EXPIRED"].includes(device.status) && <><p>管理者に確認してください。登録をやり直す場合は新しく申請します。</p><button className="secondary" disabled={busy} onClick={() => { setApplication(null); setClaimed(false); setMessage(""); }}>もう一度申請する</button></>}
    </div> : <form className="settings-section compact-form" onSubmit={apply}>
      <label htmlFor="device-name">端末名</label><input id="device-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required disabled={busy} placeholder="例：入口の受付スマートフォン" />
      <p className="field-help">管理者が見分けられる名前を付けてください。</p><div className="inline-actions"><button disabled={busy} type="submit">{busy ? "申請しています…" : "管理者へ承認を申請"}</button></div>
    </form>}
  </section>;
}
