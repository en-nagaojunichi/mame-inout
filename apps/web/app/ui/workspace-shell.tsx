import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "./brand";

export function WorkspaceShell({ label, children }: { label: string; children: ReactNode }) {
  const headerLabel = label === "受付端末" ? "QR受付の準備" : label === "管理者設定" ? "管理者の設定" : label;
  return <>
    <a className="skip-link" href="#main">本文へ移動</a>
    <header className="site-header"><Link href="/" className="brand-link"><Brand /></Link><span className="header-label">{headerLabel}</span></header>
    <main id="main" className="workspace">{children}</main>
    <footer>開発中の検証版です。実際の名簿・入退出記録の運用開始はお待ちください。</footer>
  </>;
}
