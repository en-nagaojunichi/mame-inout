import { EnrollPanel } from "../ui/enroll-panel";
import { WorkspaceShell } from "../ui/workspace-shell";

export default function RecoverPage() {
  return <WorkspaceShell label="管理者の復旧"><EnrollPanel kind="recover" /></WorkspaceShell>;
}
