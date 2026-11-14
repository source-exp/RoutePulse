import { defineConfig } from "vite"

const apiPort = Number(process.env.API_PORT || 4174)

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  server: {
    host: process.env.VITE_HOST || "127.0.0.1",
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
})
