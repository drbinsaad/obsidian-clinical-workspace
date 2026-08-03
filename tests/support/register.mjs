/**
 * Installs the `obsidian` module hook for the test run.
 *
 * `--import` only evaluates a module; exporting a `resolve` hook from it does
 * nothing on its own. The hook has to be registered explicitly, and this has to
 * happen after tsx registers so that ours sits outermost in the chain and can
 * short-circuit before tsx tries to resolve `obsidian` from node_modules.
 */
import { register } from "node:module";

register("./obsidian-loader.mjs", import.meta.url);
