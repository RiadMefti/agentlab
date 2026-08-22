import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App.js";
import { createBrowserThemeRuntime } from "./theme/browser-theme.js";
import { registerThemeRuntimeLifecycle } from "./theme/browser-theme-lifecycle.js";
import { ThemeProvider } from "./theme/react-theme.js";
import "./styles/theme.css";
import "./styles/base.css";
import "./styles/workspace.css";
import "./styles/dialog.css";
import "./styles/responsive.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true }
  }
});

const root = document.querySelector("#root");
if (root === null) throw new Error("Application root is missing.");
const themeRuntime = createBrowserThemeRuntime(window, document);
registerThemeRuntimeLifecycle(window, themeRuntime);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider store={themeRuntime.store}>
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
);
