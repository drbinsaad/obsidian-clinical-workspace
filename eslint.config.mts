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
          allowDefaultProject: ["eslint.config.mts"]
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  ...obsidianmd.configs.recommended,
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
