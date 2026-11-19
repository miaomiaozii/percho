import * as http from "node:http";
import { createLogger } from "@percho/backend";

/** Electron's Node runtime does not enable env proxies for fetch by default.
 * Use Node's standard HTTP(S)_PROXY and NO_PROXY handling for SDK requests.
 * This is independent of Chromium's browser/system proxy (including OAuth UI).
 */
export function applyEnvironmentProxy(): void {
	const { setGlobalProxyFromEnv } = http as typeof http & {
		setGlobalProxyFromEnv?: () => () => void;
	};
	try {
		setGlobalProxyFromEnv?.();
	} catch {
		// Configuration can include credentials. Do not log the input or thrown error.
		createLogger("http-proxy").warn("Invalid HTTP_PROXY or HTTPS_PROXY; using default networking");
	}
}
