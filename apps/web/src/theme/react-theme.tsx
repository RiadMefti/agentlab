import type { ReactNode } from "react";

import { ThemeStoreContext } from "./theme-context.js";
import type { ThemeStore } from "./theme-store.js";

interface ThemeProviderProps {
  readonly children: ReactNode;
  readonly store: ThemeStore;
}

export function ThemeProvider({ children, store }: ThemeProviderProps) {
  return <ThemeStoreContext value={store}>{children}</ThemeStoreContext>;
}
