"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { UserListItem } from "@/lib/users";
import { addUserAction, resetPinAction, setAdminAction, setActiveAction } from "./actions";
import { actionErrorMessage } from "@/lib/error-message";

export default function UsersClient({
  initialUsers,
  currentUserId,
}: {
  initialUsers: UserListItem[];
  currentUserId: string;
}) {
  // router.refresh() re-runs the Server Component and passes fresh
  // `initialUsers` props after every mutation below. useOptimistic flips a
  // toggle instantly against that base and snaps back on its own if the
  // transition ends without a refresh (i.e. the action errored).
  const [users, applyOptimisticToggle] = useOptimistic(
    initialUsers,
    (state, patch: { id: string; isAdmin?: boolean; active?: boolean }) =>
      state.map((u) => (u.id === patch.id ? { ...u, ...patch } : u)),
  );
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Inline PIN-reset editor. Replaces prompt(), which blocked the event loop,
  // dropped an unstyled OS dialog into a themed app, and accepted any string
  // with no client-side validation at all.
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [resetPinValue, setResetPinValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function refresh() {
    router.refresh();
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await addUserAction(name, pin);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        setName("");
        setPin("");
        refresh();
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't add that user — please retry."));
      }
    });
  }

  function submitResetPin(userId: string) {
    setError(null);
    if (!/^\d{4}$/.test(resetPinValue)) {
      setError("PIN must be exactly 4 digits.");
      return;
    }
    startTransition(async () => {
      try {
        const result = await resetPinAction(userId, resetPinValue);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        setResettingUserId(null);
        setResetPinValue("");
        refresh();
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't reset that PIN — please retry."));
      }
    });
  }

  function toggleAdmin(u: UserListItem) {
    startTransition(async () => {
      setError(null);
      applyOptimisticToggle({ id: u.id, isAdmin: !u.isAdmin });
      try {
        const result = await setAdminAction(u.id, !u.isAdmin);
        if (result.status === "error") setError(result.message);
        else refresh();
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't update that user — please retry."));
      }
    });
  }

  function toggleActive(u: UserListItem) {
    startTransition(async () => {
      setError(null);
      applyOptimisticToggle({ id: u.id, active: !u.active });
      try {
        const result = await setActiveAction(u.id, !u.active);
        if (result.status === "error") setError(result.message);
        else refresh();
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't update that user — please retry."));
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between route-line pb-2">
        <h2 className="font-stencil text-xl tracking-wide">Crew Roster</h2>
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
            className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b border-line bg-paper-panel ${
              u.active ? "" : "opacity-40"
            }`}
          >
            <div className="flex-1 min-w-[140px]">
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
            {/* Grouped so the three actions wrap onto their own line together
                on a narrow phone, rather than each button wrapping alone in
                a different place mid-row. */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={() => {
                  setError(null);
                  setResetPinValue("");
                  setResettingUserId((cur) => (cur === u.id ? null : u.id));
                }}
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

            {resettingUserId === u.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitResetPin(u.id);
                }}
                className="w-full flex items-end gap-2 flex-wrap border-t border-line pt-3"
              >
                <label className="flex flex-col gap-1">
                  <span className="tag-label">New PIN for {u.name}</span>
                  <input
                    value={resetPinValue}
                    onChange={(ev) => setResetPinValue(ev.target.value.replace(/\D/g, "").slice(0, 4))}
                    inputMode="numeric"
                    autoComplete="off"
                    autoFocus
                    placeholder="4 digits"
                    className="data w-32 border border-line-strong px-3 py-2 bg-paper"
                  />
                </label>
                <button
                  type="submit"
                  disabled={isPending}
                  className="btn px-4 py-2 bg-orange text-paper disabled:opacity-50"
                >
                  {isPending ? "Saving…" : "Save PIN"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setResettingUserId(null);
                    setResetPinValue("");
                  }}
                  className="tag-label hover:!text-ink"
                >
                  Cancel
                </button>
              </form>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
