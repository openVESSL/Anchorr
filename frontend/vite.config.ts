import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// `npm run dev` serves the dashboard on http://127.0.0.1:5173 and forwards /api to Anchorr on :8282.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { proxy: { "/api": "http://127.0.0.1:8282", "/assets": "http://127.0.0.1:8282" } },
  // "app/" so built files never collide with the server's /assets (logo, screenshots)
  build: { assetsDir: "app", chunkSizeWarningLimit: 1000 }, // self-hosted dashboard, one bundle is fine
})
