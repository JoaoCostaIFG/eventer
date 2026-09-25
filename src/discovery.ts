import {logger} from './log.js';

export interface Endpoints {
	/** Base URL for API requests (discovered `endpoints.api_public` or the API_URL override). */
	api: string;
	/** Gateway WebSocket URL (discovered `endpoints.gateway` or the GATEWAY_URL override). */
	gateway: string;
	/** Media Proxy base URL, used for avatar URLs in embeds. */
	media?: string;
	/** Static CDN base URL, used for default avatar URLs in embeds. */
	staticCdn?: string;
}

interface DiscoveryDocument {
	endpoints?: {
		api_public?: string;
		gateway?: string;
		media?: string;
		static_cdn?: string;
	};
}

/**
 * Resolve the instance's endpoints.
 *
 * When both `apiUrl` and `gatewayUrl` overrides are set, discovery is skipped
 * entirely (direct internal routing). Otherwise `/.well-known/fluxer` on the
 * instance origin is read, which is unauthenticated.
 */
export async function discoverEndpoints(options: {
	instanceUrl: string;
	apiUrl?: string;
	gatewayUrl?: string;
}): Promise<Endpoints> {
	const {instanceUrl, apiUrl, gatewayUrl} = options;

	if (apiUrl && gatewayUrl) {
		logger.info('Using direct endpoint overrides (discovery skipped)');
		return {api: apiUrl, gateway: gatewayUrl};
	}

	const url = `${instanceUrl}/.well-known/fluxer`;
	logger.info(`Discovering endpoints from ${url}`);
	const response = await fetch(url, {headers: {Accept: 'application/json'}});
	if (!response.ok) {
		throw new Error(`Instance discovery failed: ${response.status} ${response.statusText} from ${url}`);
	}
	const document = (await response.json()) as DiscoveryDocument;
	const endpoints = document.endpoints ?? {};
	if (!endpoints.api_public || !endpoints.gateway) {
		throw new Error(`Instance discovery document at ${url} is missing api_public/gateway endpoints`);
	}

	return {
		api: endpoints.api_public.replace(/\/+$/, ''),
		gateway: endpoints.gateway.replace(/\/+$/, ''),
		media: endpoints.media?.replace(/\/+$/, ''),
		staticCdn: endpoints.static_cdn?.replace(/\/+$/, ''),
	};
}
