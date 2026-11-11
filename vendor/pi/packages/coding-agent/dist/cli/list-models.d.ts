/**
 * List available models with optional fuzzy search
 */
import type { ModelRuntime } from "../core/model-runtime.ts";
/**
 * List available models, optionally filtered by search pattern
 */
export declare function listModels(modelRuntime: Pick<ModelRuntime, "getError" | "getAvailable">, searchPattern?: string, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=list-models.d.ts.map