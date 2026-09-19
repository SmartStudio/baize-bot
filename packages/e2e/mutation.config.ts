import { defineConfig, mergeConfig } from "vitest/config";
import config from "./vitest.config.js";

export default mergeConfig(config, defineConfig({ test: { setupFiles: ["./test/mutation.setup.ts"] } }));
