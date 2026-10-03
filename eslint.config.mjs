import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const frameworkBan = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        { name: "next", message: "Framework-free package: no Next.js imports." },
        { name: "react", message: "Framework-free package: no React imports." },
        { name: "react-dom", message: "Framework-free package: no React imports." },
        { name: "hono", message: "Framework-free package: no HTTP framework imports." },
      ],
      patterns: [
        { group: ["next/*", "react-dom/*", "react/*", "hono/*"], message: "Framework-free package: no framework imports." },
      ],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.next-*/**",
      ".playwright-mcp/**",
      ".claude/**",
      "test-results/**",
      "playwright-report/**",
      "**/dist/**",
      "**/next-env.d.ts",
      "packages/db/migrations/**",
      "data/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["packages/core/**/*.ts", "packages/importers/**/*.ts", "packages/contracts/**/*.ts"],
    rules: frameworkBan,
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
);
