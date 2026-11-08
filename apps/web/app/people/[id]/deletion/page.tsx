import { AdminShell } from "../../../ui/admin-shell";
import { PersonDeletionPanel } from "../../../ui/person-deletion-panel";

export const metadata = { title: "個人情報の削除 | 入退出管理システム" };

export default async function PersonDeletionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AdminShell><PersonDeletionPanel key={id} personId={id} /></AdminShell>;
}
