import { AdminShell } from "../../ui/admin-shell";
import { SettingsPanel } from "../../ui/settings-panel";

export const metadata = { title: "管理者 | MameInOut" };

export default function AdministratorsSettingsPage() {
  return <AdminShell><SettingsPanel section="administrators" /></AdminShell>;
}
