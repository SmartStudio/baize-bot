import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./ds/styles.css";
import "./app.css";
import { App } from "./app.js";
import { BrandBookProvider } from "./components/BrandBookDialog.js";
import { AppProvider } from "./state/app.js";

const host = document.getElementById("root");
if (!host) throw new Error("index.html 少了 #root");

createRoot(host).render(
  <BrowserRouter>
    <AppProvider>
      <BrandBookProvider>
        <App />
      </BrandBookProvider>
    </AppProvider>
  </BrowserRouter>,
);
