import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function getBasePath() {
  const basePath = process.env.BASE_PATH?.trim();

  if (!basePath || basePath === "/") {
    return "/";
  }

  return basePath.endsWith("/") ? basePath : `${basePath}/`;
}

export default defineConfig({
  base: getBasePath(),
  plugins: [react()],
});
