import { AdminShell } from "../../ui/admin-shell";
import { AppearancePanel } from "../../ui/appearance-panel";

export const metadata = { title: "表示設定 | 入退出管理システム" };

export default function AppearancePage() {
  return <AdminShell><AppearancePanel /></AdminShell>;
}
