import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App.js";
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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
