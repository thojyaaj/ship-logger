"use client";

import { useRouter } from "next/navigation";
import { switchUser } from "./actions";

export default function SwitchUserButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await switchUser();
        router.replace("/login");
        router.refresh();
      }}
      className="btn border border-paper/30 text-paper/70 hover:text-paper hover:border-paper/60 px-3 py-1.5"
    >
      Switch
    </button>
  );
}
