import { Suspense } from "react";
import { AdminShell } from "../ui/admin-shell";
import { PresencePanel } from "../ui/presence-panel";

export const metadata = { title: "在室一覧 | 入退出管理システム" };
export default function PresencePage() {
  return <AdminShell><Suspense fallback={<p role="status">在室一覧を準備しています…</p>}><PresencePanel /></Suspense></AdminShell>;
}
