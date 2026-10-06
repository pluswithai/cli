import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
      // The spec's bar, enforced: anything less fails `npm test`.
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
