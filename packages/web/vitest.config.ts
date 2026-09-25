export default {
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // 本地日和 UTC 日要在一天里有错开的时段，按 UTC 算日期的错误才会变红。时区跟着机器走的话，UTC 的 CI 抓不到。
    env: { TZ: "Asia/Shanghai" },
  },
};
