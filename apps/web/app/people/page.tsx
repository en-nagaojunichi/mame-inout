import { AdminShell } from "../ui/admin-shell";
import { PeoplePanel } from "../ui/people-panel";

export const metadata = { title: "利用者 | 入退出管理システム" };

export default function PeoplePage() {
  return <AdminShell><PeoplePanel /></AdminShell>;
}
