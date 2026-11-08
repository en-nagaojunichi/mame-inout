import { AdminShell } from "../../ui/admin-shell";
import { SettingsPanel } from "../../ui/settings-panel";

export const metadata = { title: "QR受付端末 | 入退出管理システム" };

export default function DevicesSettingsPage() {
  return <AdminShell><SettingsPanel section="devices" /></AdminShell>;
}
