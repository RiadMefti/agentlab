import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-types/**",
      "**/.test-types/**",
      "**/coverage/**",
      "node_modules/**",
      "apps/web/vite.config.js",
      "apps/web/vite.config.d.ts",
      "eslint.config.js"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["apps/desktop/src/*.cjs", "scripts/*.mjs"],
          defaultProject: "tsconfig.base.json"
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }]
    }
  },
  {
    files: [
      "apps/desktop/**/*.{cjs,ts}",
      "apps/server/**/*.ts",
      "packages/**/*.ts",
      "scripts/*.mjs",
      "*.config.{js,ts}"
    ],
    languageOptions: { globals: globals.node }
  },
  {
    files: ["apps/desktop/src/preload.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  },
  {
    files: ["apps/server/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/application/**", "**/http/**", "**/infrastructure/**"],
              message: "Domain modules must not depend on application or infrastructure code."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["apps/server/src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/http/**", "**/infrastructure/**"],
              message: "Application modules must depend on ports, not concrete infrastructure."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off"
    }
  }
);
