import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        contact_search: "contact_search.html",
        contact_reference_search: "contact_reference_search.html",
      },
    },
  },
});
