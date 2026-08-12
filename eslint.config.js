import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["coverage", "dist", "dist-electron", "release", ".*", "rust/**/target/**"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: {
      react,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      // Stricter than the react-hooks preset, which sets this to "warn".
      "react-hooks/exhaustive-deps": "error",
      // React Compiler rules newly enforced by eslint-plugin-react-hooks 7.1.1.
      // They report 38 pre-existing findings in src/; kept visible as warnings
      // pending a dedicated follow-up rather than dropped from the config.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react/jsx-key": "error",
    },
  },
  {
    files: ["*.{js,mjs,cjs}", "scripts/**/*.{js,mjs,cjs}"],
    extends: [
      js.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  },
]);
