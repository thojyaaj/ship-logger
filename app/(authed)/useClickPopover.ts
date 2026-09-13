"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "Click to reveal, click elsewhere to close" for one inline popover per
 * list (a Scanned At timestamp, a full status string, etc.) — click instead
 * of hover so it works the same on touch. `openId` is whatever id (a scan
 * id, a composite key) identifies which row's popover is open; attach `ref`
 * to that one row's popover container so the outside-click check only
 * looks at the currently-open element, not every row.
 */
export function useClickPopover<T = string>() {
  const [openId, setOpenId] = useState<T | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (openId === null) return;
    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenId(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [openId]);

  return { openId, setOpenId, ref } as const;
}
