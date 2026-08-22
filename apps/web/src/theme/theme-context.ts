import { createContext } from "react";

import type { ThemeStore } from "./theme-store.js";

export const ThemeStoreContext = createContext<ThemeStore | null>(null);
