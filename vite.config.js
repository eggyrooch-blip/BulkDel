import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
    base: "./",
    plugins: [react()],
    server: {
        host: "0.0.0.0",
    },
    build: {
        chunkSizeWarningLimit: 1200,
        rollupOptions: {
            external: ["#minpath", "#minproc", "#minurl"],
            output: {
                manualChunks(id) {
                    if (!id.includes("node_modules")) {
                        return undefined;
                    }

                    if (id.includes("@douyinfe/semi")) {
                        return "semi-ui";
                    }

                    if (id.includes("@lark-base-open")) {
                        return "lark-sdk";
                    }

                    if (
                        id.includes("/react/") ||
                        id.includes("/react-dom/") ||
                        id.includes("scheduler") ||
                        id.includes("use-sync-external-store")
                    ) {
                        return "react-vendor";
                    }

                    return "vendor";
                },
            },
        },
    },
});
