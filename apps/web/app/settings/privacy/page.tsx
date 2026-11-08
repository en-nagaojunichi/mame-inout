import { AdminShell } from "../../ui/admin-shell";
import { PrivacyPanel } from "../../ui/privacy-panel";

export const metadata = { title: "保存と削除 | 入退出管理システム" };

export default function PrivacyPage() {
  return <AdminShell><PrivacyPanel /></AdminShell>;
}
