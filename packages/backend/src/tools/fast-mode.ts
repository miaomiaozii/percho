import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** 走 OpenAI Responses 请求体（支持 `service_tier`）的 Pi api */
const FAST_MODE_APIS: ReadonlySet<string> = new Set(["openai-codex-responses", "openai-responses"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 快速模式改写：开关开 且 模型 api 属于 OpenAI Responses 系 → 带 `service_tier: "priority"`。
 * 已显式带 `service_tier`（含 SDK 的 `serviceTier` 选项写入）不覆盖；其他情况返回 undefined（不改 payload）。
 */
export function applyFastMode(payload: unknown, api: string | undefined, enabled: boolean): unknown {
	if (!enabled || !api || !FAST_MODE_APIS.has(api)) return undefined;
	if (!isRecord(payload) || payload.service_tier !== undefined) return undefined;
	return { ...payload, service_tier: "priority" };
}

/**
 * 快速模式扩展（Codex fast mode）。`before_provider_request` 事件只带 payload、不带模型
 * （SDK 的 transformProviderPayload 丢弃了 onPayload 的 model 参数），所以模型取 `ctx.model`
 * （会话当前模型，即本次会话请求所用模型）。handler 返回新 payload 即替换，undefined 即不改。
 */
export function makeFastModeExtension(options: { isEnabled: () => boolean }): InlineExtension {
	return {
		name: "fast-mode",
		factory: (pi) => {
			pi.on("before_provider_request", (event, ctx) =>
				applyFastMode(event.payload, ctx.model?.api, options.isEnabled()),
			);
		},
	};
}
