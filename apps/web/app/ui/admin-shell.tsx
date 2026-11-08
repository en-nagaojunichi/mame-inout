"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { adminResponseSchema, type AdminResponse } from "@mame/contracts";
import { api, authClient } from "./client-api";
import { Brand } from "./brand";
import "./management.css";

const navigation = [
  { href: "/admin", label: "管理ホーム" },
  { href: "/presence", label: "在室一覧" },
  { href: "/attendance", label: "入退室履歴" },
  { href: "/people", label: "利用者" },
  { href: "/settings/devices", label: "QR受付端末" },
  { href: "/settings/administrators", label: "管理者" },
  { href: "/settings/appearance", label: "表示設定" },
  { href: "/settings", label: "自分の設定" },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [admin, setAdmin] = useState<AdminResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void api("/api/admin/me", adminResponseSchema)
      .then((identity) => { if (active) setAdmin(identity); })
      .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : "管理画面を開けませんでした。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function signOut() {
    setBusy(true); setMessage("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("ログアウトを確認できませんでした。接続を確認して、もう一度お試しください。");
      setAdmin(null); router.replace("/");
    } catch (error) { setMessage(error instanceof Error ? error.message : "ログアウトを確認できませんでした。"); }
    finally { setBusy(false); }
  }

  const currentLabel = navigation.find((item) => item.href === pathname)?.label ?? "管理画面";
  const menu = <ul>{navigation.map((item) => <li key={item.href}><Link href={item.href} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</Link></li>)}</ul>;
  return <div className="admin-app">
    <a className="skip-link" href="#main">本文へ移動</a>
    <header className="admin-header">
      <Link href="/admin" className="brand-link"><Brand /></Link>
      {admin && <div className="admin-account"><Link href="/settings">{admin.user.name}<span className="visually-hidden">さんの設定</span></Link><button className="secondary small-button" disabled={busy} onClick={() => void signOut()}>{busy ? "ログアウト中…" : "ログアウト"}</button></div>}
    </header>
    <div className="admin-layout">
      {admin && <>
        <nav className="admin-sidebar" aria-label="管理メニュー">{menu}<p className="admin-nav-help">管理者の画面</p></nav>
        <details className="admin-mobile-menu" key={pathname}><summary><span>{currentLabel}</span><span>メニュー</span></summary><nav aria-label="管理メニュー">{menu}</nav></details>
      </>}
      <main id="main" className="admin-main">
        {message && <div className="notice error" role="alert">{message}</div>}
        {loading ? <p role="status">ログインの状態を確認しています…</p> : admin ? children : <section className="content-panel"><h1>管理者のログインが必要です</h1><p>登録済みのパスキーでログインしてください。受付用に承認された端末から、管理情報を見ることはできません。</p><Link className="button-link" href="/">ログイン画面へ</Link></section>}
      </main>
    </div>
    <footer className="admin-footer">開発中の検証版です。動作確認用の情報を使用してください。</footer>
  </div>;
}
