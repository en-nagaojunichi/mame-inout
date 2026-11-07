"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { adminResponseSchema, registrationBeginResponseSchema, recoveryCodesResponseSchema } from "@mame/contracts";
import { api, ApiFailure, authClient, requirePasskey } from "./client-api";
import { RecoveryCodesModal } from "./recovery-codes-modal";

export function EnrollPanel({ kind }: { kind: "invite" | "recover" }) {
  const recovery = kind === "recover";
  const router = useRouter();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(true);
  const [signOutRequired, setSignOutRequired] = useState(false);
  const [started, setStarted] = useState<{ name: string; email: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [registered, setRegistered] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const notice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!started) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [started]);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(""); setMessageError(true);
    let passkeySaved = false;
    let identity = started;
    try {
      requirePasskey();
      if (!started) {
        const attempt = await api(recovery ? "/api/recovery/begin" : "/api/invitations/begin", registrationBeginResponseSchema, recovery ? { email, code: code.trim() } : { code: code.trim() });
        // 復旧コードは開始時に単回消費される。認証をキャンセルした後は同じ限定手続きから再開する。
        identity = { name: attempt.name, email: attempt.email, expiresAt: Date.now() + 5 * 60_000 };
        setStarted(identity); setNow(Date.now()); setCode("");
      }
      const result = await authClient.passkey.addPasskey({ name: recovery ? "復旧後のパスキー" : "最初のパスキー", createSession: true });
      if (result.error) throw new Error("パスキーの登録は完了していません。端末の案内を確認して、もう一度お試しください。");
      passkeySaved = true; setRegistered(true); setCode("");
      const recoveryCodes = await api("/api/admin/recovery-codes", recoveryCodesResponseSchema, {});
      setCodes(recoveryCodes.codes);
    } catch (error) {
      if (!passkeySaved && identity) {
        const current = await api("/api/admin/me", adminResponseSchema).catch(() => null);
        if (current?.user.email.toLowerCase() === identity.email.toLowerCase()) {
          setRegistered(true); setCode(""); setMessageError(false);
          setMessage("パスキーの登録済み状態を確認できました。設定画面を開き、復旧コードが発行されているか確認してください。パスキーの再登録は不要です。");
          requestAnimationFrame(() => notice.current?.focus()); return;
        }
      }
      setSignOutRequired(error instanceof ApiFailure && error.code === "SIGN_OUT_REQUIRED");
      setMessage(passkeySaved ? "パスキーの登録は完了しました。復旧コードを発行できなかったため、設定画面から発行してください。パスキーの再登録は不要です。" : error instanceof Error ? error.message : "登録を完了できませんでした。");
      requestAnimationFrame(() => notice.current?.focus());
    } finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true); setMessage("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("ログアウトを確認できませんでした。通信を確認して再度お試しください。");
      setSignOutRequired(false); setMessageError(false);
      setMessage("このブラウザからログアウトしました。入力したコードで、もう一度パスキーの登録を始めてください。");
    } catch (error) { setMessageError(true); setMessage(error instanceof Error ? error.message : "ログアウトできませんでした。"); }
    finally { setBusy(false); requestAnimationFrame(() => notice.current?.focus()); }
  }

  const remaining = started ? Math.max(0, Math.ceil((started.expiresAt - now) / 1000)) : null;
  return <section className="auth-panel enrollment-panel" aria-busy={busy}>
    <p className="eyebrow">管理者のアクセス</p><h1>{recovery ? "管理者のログインを復旧" : "招待された管理者の登録"}</h1>
    <p className="intro">{recovery ? "保存した復旧コードを使い、新しいパスキーを登録します。登録が完了すると、これまでのパスキー・ログイン状態・復旧コードはすべて無効になります。" : "管理者から受け取った招待コードを入力し、ご自身の端末でパスキーを登録します。"}</p>
    {message && <div ref={notice} tabIndex={-1} className={`notice ${registered || !messageError ? "" : "error"}`} role={registered || !messageError ? "status" : "alert"}>{message}</div>}
    {signOutRequired && <div className="notice"><p>このブラウザに前回のログイン状態が残っています。復旧・招待の登録を始める前に終了してください。入力したコードはこの画面に残ります。</p><button className="secondary" disabled={busy} onClick={() => void signOut()}>このブラウザからログアウトして続ける</button></div>}
    {registered ? <div className="actions"><Link className="text-link" href="/settings">管理者の設定を開く</Link></div> : <form onSubmit={(event) => void register(event)}>
      {started ? <div className="notice"><p>登録する管理者：{started.name}<br />{started.email}<span className="small-label">メール未確認</span></p><p role="timer" aria-live="off">手続きの残り時間の目安：{Math.floor((remaining ?? 0) / 60)}分{String((remaining ?? 0) % 60).padStart(2, "0")}秒</p><p className="field-help">認証をキャンセルした場合は、この画面を開いたまま再試行できます。期限切れ・再読込・別のコードでの開始後は、{recovery ? "別の未使用の復旧コード" : "有効な招待コード"}でやり直してください。</p><button className="secondary" type="button" disabled={busy} onClick={() => { setStarted(null); setCode(""); setMessage(""); }}>別のコードでやり直す</button></div> : <>
        {recovery && <><label htmlFor="recovery-email">管理者のメールアドレス</label><input id="recovery-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></>}
        <label htmlFor="registration-code">{recovery ? "復旧コード" : "招待コード"}</label><input id="registration-code" type="password" autoComplete="off" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} required disabled={busy} />
        <p className="field-help">{recovery ? "未使用の復旧コードを1つ入力してください。全て失った場合はサーバー管理者に確認してください。" : "招待コードには有効期限があります。登録できない場合は、招待した管理者へ確認してください。"}</p>
      </>}
      <div className="notice">ご自身の端末を使用してください。共有の受付端末へのパスキー登録は避けてください。</div>
      <button type="submit" disabled={busy || remaining === 0}>{busy ? "登録を確認しています…" : remaining === 0 ? "登録手続きの期限が切れました" : "新しいパスキーを登録"}</button>
      {busy && <p className="field-help" role="status">端末の案内に従ってパスキーを登録してください。</p>}
    </form>}
    <p><Link className="text-link" href="/">ログイン画面へ戻る</Link></p>
    <RecoveryCodesModal codes={codes} onClose={() => { setCodes(null); router.push("/settings"); }} />
  </section>;
}
