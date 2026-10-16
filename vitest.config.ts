import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    {
      name: "domain-ddl",
      transform(code, id) {
        if (id.endsWith(".sql"))
          return { code: "export default " + JSON.stringify(code), map: null };
      },
    },
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
