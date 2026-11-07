import { SettingsPanel } from "../ui/settings-panel";
import { WorkspaceShell } from "../ui/workspace-shell";

export default function SettingsPage() {
  return <WorkspaceShell label="管理者設定"><SettingsPanel /></WorkspaceShell>;
}
