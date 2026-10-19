import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    target: "es2022",
    license: { fileName: "THIRD-PARTY-LICENSES.md" },
  },
  server: {
    port: 5140,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:5141" },
  },
});
