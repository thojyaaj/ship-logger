import { pageRequireAdmin } from "@/lib/auth";
import { listUsers } from "@/lib/users";
import UsersClient from "./UsersClient";

export default async function AdminUsersPage() {
  const admin = await pageRequireAdmin();
  const users = await listUsers();
  return <UsersClient initialUsers={users} currentUserId={admin.id} />;
}
