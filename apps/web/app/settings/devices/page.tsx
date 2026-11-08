import { AdminShell } from "../../ui/admin-shell";
import { SettingsPanel } from "../../ui/settings-panel";

export const metadata = { title: "QR受付端末 | MameInOut" };

export default function DevicesSettingsPage() {
  return <AdminShell><SettingsPanel section="devices" /></AdminShell>;
}
