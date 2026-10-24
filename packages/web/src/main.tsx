import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./ds/styles.css";
import "./app.css";
import { App } from "./app.js";
import { BrandBookProvider } from "./components/BrandBookDialog.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ToastProvider } from "./components/Toasts.js";
import { AppProvider } from "./state/app.js";

const host = document.getElementById("root");
if (!host) throw new Error("index.html 少了 #root");

createRoot(host).render(
  <ErrorBoundary>
    <BrowserRouter>
      <AppProvider>
        <ToastProvider>
          <BrandBookProvider>
            <App />
          </BrandBookProvider>
        </ToastProvider>
      </AppProvider>
    </BrowserRouter>
  </ErrorBoundary>,
);
