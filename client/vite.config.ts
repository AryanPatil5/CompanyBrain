import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import tsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3000, // Changed from 8080 to 3000 to avoid port conflict with FastMCP
  },
  plugins: [
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    // REMOVED: tanstackRouter() — tanstackStart handles router file generation automatically!
    tanstackStart({
      server: {
        entry: "server",
      },
    }),
    viteReact(),
  ],
});