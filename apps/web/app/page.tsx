import { AuthPanel } from "./ui/auth-panel";
import Link from "next/link";
import { Brand } from "./ui/brand";
import { AppVersion } from "./ui/app-version";

export default function Page() {
  return <>
    <a className="skip-link" href="#main">本文へ移動</a>
    <header className="site-header"><Brand /><span className="header-label">管理者</span></header>
    <main id="main"><AuthPanel /></main>
    <footer><nav className="footer-links" aria-label="登録の案内"><Link href="/invite">招待された管理者の登録</Link><Link href="/device">QR受付に使う端末を登録</Link></nav>QR受付に使う端末の登録には、管理者のログインは不要です。<br /><AppVersion /><br />開発中の検証版です。動作確認用の情報を使用してください。</footer>
  </>;
}
