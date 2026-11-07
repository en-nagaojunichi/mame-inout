import { DevicePanel } from "../ui/device-panel";
import { WorkspaceShell } from "../ui/workspace-shell";

export default function DevicePage() {
  return <WorkspaceShell label="受付端末"><DevicePanel /></WorkspaceShell>;
}
