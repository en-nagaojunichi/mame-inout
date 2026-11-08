import { AdminShell } from "../../ui/admin-shell";
import { DiagnosticsPanel } from "../../ui/diagnostics-panel";

export const metadata = { title: "稼働状況 | 入退出管理システム" };

export default function DiagnosticsPage() {
  return <AdminShell><DiagnosticsPanel /></AdminShell>;
}
