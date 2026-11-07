import { AuthPanel } from "./ui/auth-panel";

export default function Page() {
  return <>
    <a className="skip-link" href="#main">本文へ移動</a>
    <header className="site-header"><div className="brand"><span className="brand-mark" aria-hidden="true" />MameInOut</div><span className="header-label">管理者</span></header>
    <main id="main"><AuthPanel /></main>
    <footer>開発中の認証確認版です。入退出の受付・復旧機能は準備中です。</footer>
  </>;
}
