import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const sharedSrc = fileURLToPath(new URL("../shared/src/index.ts", import.meta.url));

// 真控制面在 3001。端到端跑的是 mock/server.ts，用 API_PORT 把两边挪到一个不跟别的进程抢的端口。
const apiPort = process.env["API_PORT"] ?? "3001";

// /gateway 是云电脑代理连控制面用的，不是前端路由。不挡住它，Vite 的 SPA 回退会拿 index.html 当 200 回，
// 代理会以为自己握上手了。
const rejectGateway = (): Plugin => ({
  name: "baize-reject-gateway",
  configureServer: (server) => {
    server.middlewares.use("/gateway", (_req, res) => {
      res.statusCode = 404;
      res.end();
    });
  },
});

export default defineConfig({
  plugins: [react(), rejectGateway()],
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
