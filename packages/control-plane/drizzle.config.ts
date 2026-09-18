import type { Config } from "drizzle-kit";

// drizzle-kit 加载这个文件时解析不到 "./src/env.js"，所以默认值在这里重复一次。
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "postgres://baize:baize@localhost:5434/baize" },
} satisfies Config;
