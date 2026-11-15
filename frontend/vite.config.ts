import path from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Windows: started from a working directory with a lowercase drive letter (c:\...), the
// bundler sees c:\ and C:\ as different module ids, ships React twice and the page stays
// blank ("Cannot read properties of null (reading 'useState')"). Use one spelling.
const sameDrive = (p: string) => p.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
const here = sameDrive(path.dirname(fileURLToPath(import.meta.url)))
if (process.platform === "win32") process.chdir(sameDrive(process.cwd()))

// `npm run dev` serves the dashboard on http://127.0.0.1:5173 and forwards /api to Anchorr on :8282.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.join(here, "src") } },
  server: { proxy: { "/api": "http://127.0.0.1:8282", "/assets": "http://127.0.0.1:8282" } },
  // "app/" so built files never collide with the server's /assets (logo, screenshots)
  build: { assetsDir: "app", chunkSizeWarningLimit: 1000 }, // self-hosted dashboard, one bundle is fine
})
