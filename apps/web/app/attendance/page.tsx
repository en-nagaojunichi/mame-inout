import { Suspense } from "react";
import { AdminShell } from "../ui/admin-shell";
import { HistoryPanel } from "../ui/history-panel";

export const metadata = { title: "入退室履歴 | 入退出管理システム" };
export default function AttendancePage() {
  return <AdminShell><Suspense fallback={<p role="status">履歴を準備しています…</p>}><HistoryPanel /></Suspense></AdminShell>;
}
