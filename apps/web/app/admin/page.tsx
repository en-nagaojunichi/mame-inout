import { AdminShell } from "../ui/admin-shell";
import { AdminHome } from "../ui/admin-home";

export const metadata = { title: "管理ホーム | MameInOut" };

export default function AdminPage() {
  return <AdminShell><AdminHome /></AdminShell>;
}
