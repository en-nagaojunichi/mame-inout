import { EnrollPanel } from "../ui/enroll-panel";
import { WorkspaceShell } from "../ui/workspace-shell";

export default function InvitePage() {
  return <WorkspaceShell label="管理者の招待"><EnrollPanel kind="invite" /></WorkspaceShell>;
}
