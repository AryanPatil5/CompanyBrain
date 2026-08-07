import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000, // Changed from 8080 to 3000 to avoid port conflict with FastMCP
    allowedHosts: [".ngrok-free.dev", ".ngrok.io", ".trycloudflare.com"],
  },
  plugins: [
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
