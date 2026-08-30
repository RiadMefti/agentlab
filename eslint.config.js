import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-types/**",
      "**/.test-types/**",
      "**/coverage/**",
      "node_modules/**",
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
          allowDefaultProject: ["scripts/*.mjs", "tests/fixtures/*.mjs"],
          defaultProject: "tsconfig.base.json",
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 9
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ["apps/tui/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node, Bun: "readonly" } },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  },
  {
    files: ["packages/**/*.ts", "scripts/*.{mjs,ts}", "tests/fixtures/*.mjs", "*.config.{js,ts}"],
    languageOptions: { globals: { ...globals.node, Bun: "readonly" } }
  },
  {
    files: ["packages/runtime/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/application/**", "**/infrastructure/**"],
              message: "Domain modules must not depend on application or infrastructure code."
            },
            {
              group: ["react", "react/*", "@opentui/*", "@agentlab/tui"],
              message: "Domain modules must remain independent of presentation frameworks."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["packages/runtime/src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/infrastructure/**"],
              message: "Application modules must depend on ports, not concrete infrastructure."
            },
            {
              group: ["react", "react/*", "@opentui/*", "@agentlab/tui"],
              message: "Application modules must remain independent of presentation frameworks."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/*.bun.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off"
    }
  }
);
