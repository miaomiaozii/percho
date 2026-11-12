import { defineConfig } from "vitest/config";

/**
 * 媒体事务/频道观察这类用例会做文件和目录 fsync（持久化步骤），在 Windows 上叠加
 * 杀软扫描单例可以到 5s 以上（Linux CI 远低于默认 5s）。默认 5s 超时会把它们判成
 * 失败，看起来像"整块挂死"。这里只放宽超时，不减少覆盖、不跳过任何平台。
 */
export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
