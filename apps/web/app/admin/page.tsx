import { AdminShell } from "../ui/admin-shell";
import { AdminHome } from "../ui/admin-home";

export const metadata = { title: "管理ホーム | 入退出管理システム" };

export default function AdminPage() {
  return <AdminShell><AdminHome /></AdminShell>;
}
