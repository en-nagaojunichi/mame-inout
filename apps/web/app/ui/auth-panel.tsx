"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { adminResponseSchema, type AdminResponse } from "@mame/contracts";

const authClient = createAuthClient({ plugins: [passkeyClient()] });
type Stage = "loading" | "setup" | "login" | "ready" | "unavailable";
type CompletedAction = { origin: Element | null; moved: boolean };

async function loadState(): Promise<{ stage: Stage; admin: AdminResponse | null }> {
  const me = await fetch("/api/admin/me", { cache: "no-store" });
  if (me.ok) return { admin: adminResponseSchema.parse(await me.json()), stage: "ready" };
  if (me.status !== 401) throw new Error("状態を確認できませんでした。しばらく待って再確認してください。");
  const response = await fetch("/api/setup/status", { cache: "no-store" });
  if (!response.ok) throw new Error("接続を確認できませんでした。再確認してください。");
  const status = await response.json() as { completed: boolean };
  return { stage: status.completed ? "login" : "setup", admin: null };
}

export function AuthPanel() {
  const [stage, setStage] = useState<Stage>("loading");
  const [admin, setAdmin] = useState<AdminResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [noticeKind, setNoticeKind] = useState<"error" | "success">("error");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const [completedAction, setCompletedAction] = useState<CompletedAction | null>(null);

  async function refresh() {
    const state = await loadState();
    setStage(state.stage); setAdmin(state.admin);
  }

  useEffect(() => {
    let active = true;
    void loadState().then((state) => { if (active) { setStage(state.stage); setAdmin(state.admin); } })
      .catch(() => { if (active) { setStage("unavailable"); setMessage("接続できませんでした。通信状況を確認して再確認してください。"); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!completedAction || completedAction.moved) return;
    const active = document.activeElement;
    // 初回読込では動かさず、操作元の無効化・削除で失われたフォーカスだけを結果へつなぐ。
    if (active !== completedAction.origin && active !== document.body && active !== document.documentElement) return;
    (messageRef.current ?? headingRef.current)?.focus();
  }, [completedAction]);

  async function run(action: () => Promise<void>) {
    const focus = { origin: document.activeElement, moved: false };
    const movedFocus = (event: FocusEvent) => {
      if (event.target !== focus.origin && event.target !== document.body && event.target !== document.documentElement) focus.moved = true;
    };
    const movedPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !focus.origin?.contains(event.target)) focus.moved = true;
    };
    const movedKeyboard = (event: KeyboardEvent) => { if (event.key === "Tab") focus.moved = true; };
    // 待機中に利用者が別の操作へ移った場合は、結果表示によってフォーカスを奪わない。
    document.addEventListener("focusin", movedFocus);
    document.addEventListener("pointerdown", movedPointer);
    document.addEventListener("keydown", movedKeyboard);
    setBusy(true); setMessage(""); setNoticeKind("error");
    try { await action(); } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作を完了できませんでした。もう一度お試しください。");
    } finally {
      document.removeEventListener("focusin", movedFocus);
      document.removeEventListener("pointerdown", movedPointer);
      document.removeEventListener("keydown", movedKeyboard);
      setBusy(false); setCompletedAction(focus);
    }
  }

  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      if (!window.isSecureContext || !window.PublicKeyCredential) throw new Error("パスキーを利用できません。対応ブラウザで正しいURLを開いてください。");
      const response = await fetch("/api/setup/begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), name, email }) });
      if (!response.ok) {
        const failure = await response.json() as { message?: string };
        throw new Error(failure.message ?? "初期設定を開始できませんでした。");
      }
      const result = await authClient.passkey.addPasskey({ name: "最初のパスキー", createSession: true });
      if (result.error) throw new Error("パスキー登録は完了していません。端末の案内に従って、もう一度お試しください。");
      setCode("");
      await refresh();
    });
  }

  return <section className="auth-panel" aria-busy={busy || stage === "loading"}>
    <p className="eyebrow">管理者のアクセス</p>
    <h1 ref={headingRef} tabIndex={-1} aria-live="polite" aria-atomic="true">{stage === "setup" ? "最初の管理者を登録" : stage === "ready" ? "接続を確認できました" : "パスキーでログイン"}</h1>
    <p className="intro">{stage === "setup" ? "サーバー管理者から受け取った設定コードを入力し、この端末にパスキーを登録します。" : stage === "ready" ? "管理者としてログインしています。確認が終わったらログアウトしてください。" : "指紋・顔認証や端末の画面ロックで、管理者画面を開きます。"}</p>

    {message && <div ref={messageRef} tabIndex={-1} className={`notice ${noticeKind}`} role={noticeKind === "error" ? "alert" : "status"}>{message}</div>}
    {message && noticeKind === "error" && stage !== "unavailable" && <button className="secondary" disabled={busy} onClick={() => void run(refresh)}>状態を再確認</button>}
    {stage === "loading" && <p role="status" className="notice">状態を確認しています…</p>}
    {stage === "unavailable" && <button disabled={busy} onClick={() => void run(refresh)}>接続を再確認</button>}
    {stage === "setup" && <form onSubmit={register}>
      <label htmlFor="setup-code">設定コード</label>
      <input id="setup-code" type="password" autoComplete="off" spellCheck={false} required value={code} onChange={(e) => setCode(e.target.value)} aria-describedby="code-help" disabled={busy} />
      <p className="field-help" id="code-help">発行から15分間有効です。コードがない場合はサーバー管理者に確認してください。</p>
      <label htmlFor="admin-name">表示名</label>
      <input id="admin-name" autoComplete="name" maxLength={100} required value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      <label htmlFor="admin-email">メールアドレス</label>
      <input id="admin-email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby="email-help" disabled={busy} />
      <p className="field-help" id="email-help">管理者の識別に使います。確認メールは送信されません。</p>
      <div className="notice">ご自身の端末を使用してください。共有の受付端末への登録は避けてください。</div>
      <button type="submit" disabled={busy}>{busy ? "登録を確認しています…" : "パスキーを登録"}</button>
    </form>}
    {stage === "login" && <div className="actions">
      <button disabled={busy} onClick={() => void run(async () => {
        const result = await authClient.signIn.passkey();
        if (result.error) throw new Error("ログインは完了していません。パスキーを選び直してお試しください。");
        await refresh();
      })}>{busy ? "認証を確認しています…" : "パスキーでログイン"}</button>
      <p className="field-help">登録済みのパスキーを選んでください。</p>
    </div>}
    {stage === "ready" && admin && <>
      <dl className="account-details"><div><dt>管理者</dt><dd>{admin.user.name}</dd></div><div><dt>メールアドレス</dt><dd>{admin.user.email}<span className="small-label">未確認</span></dd></div><div><dt>接続の状態</dt><dd><span className="status-dot" aria-hidden="true" />認証済みの接続を確認</dd></div></dl>
      <div className="actions"><button className="secondary" disabled={busy} onClick={() => void run(async () => {
        const result = await authClient.signOut();
        if (result.error) throw new Error("ログアウトの完了を確認できません。通信状況を確認して再度お試しください。");
        await refresh();
        setNoticeKind("success"); setMessage("ログアウトしました。");
      })}>{busy ? "処理しています…" : "ログアウト"}</button></div>
    </>}
    {busy && <p className="field-help" role="status">端末に表示される案内を確認してください。</p>}
  </section>;
}
