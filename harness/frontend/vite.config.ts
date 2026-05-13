import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig(() => {
  const backendPort =
    process.env.API_PORT ?? process.env.SWARMFLEET_PORT ?? "7080";
  const backendTarget = `http://127.0.0.1:${backendPort}`;
  const publicPort = Number.parseInt(
    process.env.SWARMFLEET_PUBLIC_PORT ?? "7070",
    10,
  );
  const hmrClientPort =
    Number.isFinite(publicPort) && publicPort > 0 ? publicPort : 7070;
  const hmrProtocol = process.env.SWARMFLEET_HMR_PROTOCOL ?? "wss";

  return {
    clearScreen: false,
    plugins: [react(), tailwindcss()],
    publicDir: resolve(__dirname, "public"),
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "../shared"),
      },
    },
    server: {
      port: 7070,
      host: "0.0.0.0",
      allowedHosts: true as const,
      hmr: {
        clientPort: hmrClientPort,
        protocol: hmrProtocol,
        timeout: 120_000,
      },
      proxy: {
        "/api": {
          target: backendTarget,
          changeOrigin: true,
          ws: true,
        },
        "/auth": {
          target: backendTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
