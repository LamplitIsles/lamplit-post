import { defineConfig } from "vitest/config";
import { parse } from "yaml";
export default defineConfig({
  plugins: [
    {
      name: "published-provider-yaml",
      transform(code, id) {
        if (/\.ya?ml$/.test(id))
          return {
            code: "export default " + JSON.stringify(parse(code)),
            map: null,
          };
      },
    },
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
    server: { deps: { inline: ["@koishi-ce/plugin-database-sqlite"] } },
  },
});
