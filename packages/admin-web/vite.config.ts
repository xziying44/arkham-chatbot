import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 管理端 SPA。开发时 vite dev server 跑在 5173，通过 proxy 转发 /api 到后端 5180。
// 生产构建输出到 dist/，由后端 admin-api 作为静态文件服务（SPA fallback → index.html）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5180",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
