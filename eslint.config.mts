import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist",
    "release",
    "package.json",
    "package-lock.json",
    "manifest.json",
    "versions.json",
    "**/._*"
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        __DEV_TOOLS__: "readonly"
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mts", "scripts/*.mjs"]
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["scripts/*.mjs"],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      // These files are repository-side Node CLIs, not part of the mobile-safe
      // Obsidian runtime bundle. Keep the general JavaScript/TypeScript checks,
      // but do not apply runtime-only Obsidian rules to them.
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/rule-custom-message": "off",
      "no-irregular-whitespace": [
        "error",
        {
          skipComments: false,
          skipJSXText: false,
          skipRegExps: false,
          skipStrings: true,
          skipTemplates: true
        }
      ]
    }
  },
  {
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["Clinical Workspace", "Bases"],
          acronyms: ["MRN", "NFN", "OPD"]
        }
      ]
    }
  }
);
