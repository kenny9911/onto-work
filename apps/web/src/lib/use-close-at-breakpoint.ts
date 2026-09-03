import { useEffect, type Dispatch, type SetStateAction } from "react";

export function useCloseAtBreakpoint(
  query: string,
  setOpen: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const closeWhenMatched = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };

    if (media.matches) setOpen(false);
    media.addEventListener("change", closeWhenMatched);
    return () => media.removeEventListener("change", closeWhenMatched);
  }, [query, setOpen]);
}
