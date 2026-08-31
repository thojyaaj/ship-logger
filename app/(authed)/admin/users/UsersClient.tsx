"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { UserListItem } from "@/lib/users";
import { addUserAction, resetPinAction, setAdminAction, setActiveAction } from "./actions";

export default function UsersClient({
  initialUsers,
  currentUserId,
}: {
  initialUsers: UserListItem[];
  currentUserId: string;
}) {
  // No local copy of the list: router.refresh() re-runs the Server Component
  // and passes fresh `initialUsers` props after every mutation below.
  const users = initialUsers;
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function refresh() {
    router.refresh();
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await addUserAction(name, pin);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      setName("");
      setPin("");
      refresh();
    });
  }

  function handleResetPin(userId: string) {
    const newPin = prompt("New 4-digit PIN:");
    if (!newPin) return;
    startTransition(async () => {
      const result = await resetPinAction(userId, newPin);
      if (result.status === "error") alert(result.message);
      else refresh();
    });
  }

  function toggleAdmin(u: UserListItem) {
    startTransition(async () => {
      const result = await setAdminAction(u.id, !u.isAdmin);
      if (result.status === "error") alert(result.message);
      else refresh();
    });
  }

  function toggleActive(u: UserListItem) {
    startTransition(async () => {
      const result = await setActiveAction(u.id, !u.active);
      if (result.status === "error") alert(result.message);
      else refresh();
    });
  }

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-2xl mx-auto w-full">
      <div className="flex items-baseline justify-between route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">Crew Roster</h1>
        <span className="tag-label">{users.length} registered</span>
      </div>

      <form onSubmit={handleAdd} className="flex gap-2 items-end flex-wrap corners p-4 bg-paper-panel">
        <label className="flex flex-col gap-1">
          <span className="tag-label">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border border-line-strong px-3 py-2 bg-paper font-condensed"
            placeholder="Mai"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="tag-label">PIN</span>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            className="data border border-line-strong px-3 py-2 w-24 bg-paper"
            placeholder="1234"
            inputMode="numeric"
          />
        </label>
        <button type="submit" disabled={isPending} className="btn px-4 py-2 bg-orange text-paper disabled:opacity-50">
          Add user
        </button>
      </form>
      {error && (
        <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm font-medium">
          ⚠ {error}
        </p>
      )}

      <div className="flex flex-col border-t border-line">
        {users.map((u) => (
          <div
            key={u.id}
            className={`flex items-center gap-3 px-4 py-3 border-b border-line bg-paper-panel ${
              u.active ? "" : "opacity-40"
            }`}
          >
            <div className="flex-1">
              <div className="font-semibold font-condensed">
                {u.name}
                {u.id === currentUserId && (
                  <span className="tag-label ml-2">You</span>
                )}
              </div>
              <div className="tag-label">
                {u.isAdmin ? "Admin" : "Packer"} · {u.active ? "Active" : "Deactivated"}
              </div>
            </div>
            <button
              onClick={() => handleResetPin(u.id)}
              className="tag-label !text-blue hover:!text-blue-ink"
              disabled={isPending}
            >
              Reset PIN
            </button>
            <button
              onClick={() => toggleAdmin(u)}
              className="tag-label hover:!text-ink"
              disabled={isPending}
            >
              {u.isAdmin ? "Remove admin" : "Make admin"}
            </button>
            <button
              onClick={() => toggleActive(u)}
              className="tag-label !text-red hover:!text-red-ink"
              disabled={isPending}
            >
              {u.active ? "Deactivate" : "Reactivate"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
