import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const sharedSrc = fileURLToPath(new URL("../shared/src/index.ts", import.meta.url));

// 真控制面在 3001。端到端跑的是 mock/server.ts，用 API_PORT 把两边挪到一个不跟别的进程抢的端口。
const apiPort = process.env["API_PORT"] ?? "3001";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@baize/shared": sharedSrc } },
  optimizeDeps: { exclude: ["@baize/shared"] },
  server: {
    host: "127.0.0.1",
    port: Number(process.env["WEB_PORT"] ?? 5173),
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false, ws: true },
    },
  },
});
