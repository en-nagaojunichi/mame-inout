import { SettingsPanel } from "../ui/settings-panel";
import { AdminShell } from "../ui/admin-shell";

export const metadata = { title: "自分の設定 | 入退出管理システム" };

export default function SettingsPage() {
  return <AdminShell><SettingsPanel section="account" /></AdminShell>;
}
