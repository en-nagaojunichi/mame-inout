"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { adminResponseSchema, type AdminResponse } from "@mame/contracts";
import { api, authClient } from "./client-api";
import { Brand } from "./brand";
import { Modal } from "./modal";
import { AppVersion } from "./app-version";
import "./management.css";

const navigation = [
  { href: "/admin", label: "管理ホーム", icon: "home", group: "日々の管理" },
  { href: "/presence", label: "在室一覧", icon: "people", group: "日々の管理" },
  { href: "/attendance", label: "入退室履歴", icon: "history", group: "日々の管理" },
  { href: "/people", label: "利用者", icon: "person", group: "日々の管理" },
  { href: "/settings/devices", label: "QR受付端末", icon: "device", group: "管理・設定" },
  { href: "/settings/administrators", label: "管理者", icon: "shield", group: "管理・設定" },
  { href: "/settings/appearance", label: "表示設定", icon: "appearance", group: "管理・設定" },
  { href: "/settings/privacy", label: "保存と削除", icon: "storage", group: "管理・設定" },
  { href: "/settings/diagnostics", label: "稼働状況", icon: "diagnostics", group: "管理・設定" },
  { href: "/settings", label: "自分の設定", icon: "settings", group: "管理・設定" },
];

function MenuIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v12h14V9M9 21v-8h6v8" /></>,
    people: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3" /></>,
    history: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    person: <><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    device: <><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M10 18h4" /></>,
    qr: <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="3" width="6" height="6" rx="1" /><rect x="3" y="15" width="6" height="6" rx="1" /><path d="M15 15h3v3h3M15 21h3M21 12v3M12 3v3M3 12h3M12 12v6" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
    appearance: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1" /><path d="m3 17 6-5 4 3 4-5 4 5" /></>,
    storage: <><path d="M4 5h16v4H4zM6 9v12h12V9M10 13h4" /></>,
    settings: <><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z" /><circle cx="12" cy="12" r="3" /></>,
    diagnostics: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  };
  return <svg className="menu-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [admin, setAdmin] = useState<AdminResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

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

  const deletingPerson = /^\/people\/[^/]+\/deletion$/.test(pathname);
  const currentLabel = deletingPerson ? "個人情報の削除" : navigation.find((item) => item.href === pathname)?.label ?? "管理画面";
  const menu = <>{["日々の管理", "管理・設定"].map((group) => <div className="nav-group" key={group}><p className="nav-group-label">{group}</p><ul>{navigation.filter((item) => item.group === group).map((item) => <li key={item.href}><Link href={item.href} onClick={() => setMenuOpen(false)} aria-current={pathname === item.href ? "page" : deletingPerson && item.href === "/people" ? "location" : undefined}><MenuIcon name={item.icon} /><span>{item.label}</span></Link></li>)}</ul></div>)}</>;
  return <div className="admin-app">
    <a className="skip-link" href="#main">本文へ移動</a>
    <header className="admin-header">
      {admin && <button ref={menuButton} className="admin-menu-button secondary" aria-label="管理メニューを開く" aria-expanded={menuOpen} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}><span className="hamburger" aria-hidden="true"><span /><span /><span /></span></button>}
      <Link href="/admin" className="brand-link"><Brand /></Link>
      {admin && <div className="admin-account"><Link href="/settings">{admin.user.name}<span className="visually-hidden">さんの設定</span></Link><button className="secondary small-button" disabled={busy} onClick={() => void signOut()}>{busy ? "ログアウト中…" : "ログアウト"}</button></div>}
    </header>
    <div className="admin-layout">
      {admin && <>
        <nav className="admin-sidebar" aria-label="管理メニュー">{menu}<div className="sidebar-reception"><MenuIcon name="device" /><p>受付用のブラウザで</p><Link href="/reception">QR受付を開く <span aria-hidden="true">↗</span></Link></div></nav>
      </>}
      <main id="main" className="admin-main">
        {admin && <p className="admin-location"><span>管理画面</span><span aria-hidden="true"> / </span>{currentLabel}</p>}
        {message && <div className="notice error" role="alert">{message}</div>}
        {loading ? <p role="status">ログインの状態を確認しています…</p> : admin ? children : <section className="content-panel"><h1>管理者のログインが必要です</h1><p>登録済みのパスキーでログインしてください。受付用に承認された端末から、管理情報を見ることはできません。</p><Link className="button-link" href="/">ログイン画面へ</Link></section>}
      </main>
    </div>
    <footer className="admin-footer"><AppVersion /></footer>
    {admin && !menuOpen && <Link className="reception-shortcut" href="/reception" prefetch={false}><MenuIcon name="qr" /><span>QR受付を開く</span></Link>}
    <Modal open={menuOpen} title="管理メニュー" description="行いたい操作を選んでください。" onClose={() => setMenuOpen(false)} returnFocusRef={menuButton}>
      <div className="mobile-nav"><button className="secondary mobile-nav-close" data-modal-initial onClick={() => setMenuOpen(false)}>メニューを閉じる <span aria-hidden="true">×</span></button><nav aria-label="管理メニュー">{menu}</nav><p className="admin-nav-help">ログイン中：{admin?.user.name}</p></div>
    </Modal>
  </div>;
}
