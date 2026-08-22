import { useCallback, useContext, useSyncExternalStore } from "react";

import { ThemeStoreContext } from "./theme-context.js";
import type { Appearance } from "./theme-policy.js";
import type { ThemeSnapshot } from "./theme-store.js";

export interface ThemeContextValue extends ThemeSnapshot {
  readonly setAppearance: (appearance: Appearance) => void;
}

export function useTheme(): ThemeContextValue {
  const store = useContext(ThemeStoreContext);
  if (store === null) throw new Error("ThemeProvider is missing.");

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const setAppearance = useCallback(
    (appearance: Appearance) => {
      store.setAppearance(appearance);
    },
    [store]
  );
  return { ...snapshot, setAppearance };
}
