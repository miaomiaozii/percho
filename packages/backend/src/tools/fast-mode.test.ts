import { describe, expect, it } from "vitest";
import { applyFastMode, makeFastModeExtension } from "./fast-mode";

describe("快速模式 payload 改写", () => {
	const payload = { model: "gpt-5", input: [] };

	it("开 + Codex/OpenAI Responses → service_tier=priority，不原地改", () => {
		for (const api of ["openai-codex-responses", "openai-responses"]) {
			expect(applyFastMode(payload, api, true)).toEqual({ ...payload, service_tier: "priority" });
		}
		expect(payload).not.toHaveProperty("service_tier");
	});

	it("关 → 不改", () => {
		expect(applyFastMode(payload, "openai-codex-responses", false)).toBeUndefined();
	});

	it("非 OpenAI Responses 模型或取不到 api → 不改", () => {
		expect(applyFastMode(payload, "anthropic-messages", true)).toBeUndefined();
		expect(applyFastMode(payload, "openai-completions", true)).toBeUndefined();
		expect(applyFastMode(payload, undefined, true)).toBeUndefined();
	});

	it("已显式有 service_tier → 不覆盖", () => {
		expect(applyFastMode({ ...payload, service_tier: "flex" }, "openai-responses", true)).toBeUndefined();
	});

	it("扩展：handler 从 ctx.model 取 api，每次实时读开关", () => {
		let enabled = false;
		let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
		const pi = {
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				if (name === "before_provider_request") handler = fn;
			},
		};
		const ext = makeFastModeExtension({ isEnabled: () => enabled });
		const factory = typeof ext === "function" ? ext : ext.factory;
		factory(pi as never);
		const event = { type: "before_provider_request", payload };
		const ctx = { model: { api: "openai-codex-responses" } };
		expect(handler?.(event, ctx)).toBeUndefined();
		enabled = true;
		expect(handler?.(event, ctx)).toEqual({ ...payload, service_tier: "priority" });
		expect(handler?.(event, { model: { api: "anthropic-messages" } })).toBeUndefined();
	});
});
