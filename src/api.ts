import type {Channel, CreateMessageBody, Message, Snowflake} from './types.js';

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | undefined,
		message: string,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

interface ErrorBody {
	code?: string;
	message?: string;
}

/**
 * Thin Fluxer HTTP API client.
 *
 * Authenticates with `Authorization: Bot <token>` and retries once on 429
 * after the advertised `Retry-After`.
 */
export class FluxerApi {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
	) {}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		let response = await this.doFetch(method, path, body);

		if (response.status === 429) {
			const retryAfterHeader = response.headers.get('Retry-After');
			const seconds = Number.parseFloat(retryAfterHeader ?? '');
			const waitMs = Number.isFinite(seconds)
				? Math.min(Math.max(seconds * 1000, 500), 60_000)
				: 1_000;
			console.warn(`[WARN ] Rate limited on ${method} ${path}; retrying in ${Math.round(waitMs)}ms`);
			await new Promise((resolve) => setTimeout(resolve, waitMs));
			response = await this.doFetch(method, path, body);
		}

		if (!response.ok) {
			let code: string | undefined;
			let message = `${response.status} ${response.statusText}`;
			try {
				const errorBody = (await response.json()) as ErrorBody;
				code = errorBody.code;
				if (errorBody.message && errorBody.message !== code) {
					message = `${message}: ${errorBody.message}`;
				}
			} catch {
				// Non-JSON error body; keep the status line
			}
			const codeSuffix = code === undefined ? '' : ` [${code}]`;
			throw new ApiError(response.status, code, `${method} ${path} failed: ${message}${codeSuffix}`);
		}

		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}

	private doFetch(method: string, path: string, body?: unknown): Promise<Response> {
		const headers: Record<string, string> = {
			Authorization: `Bot ${this.token}`,
			Accept: 'application/json',
		};
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		return fetch(`${this.baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	/** GET /v1/guilds/{guild_id}/channels — every channel the bot can see, in one body. */
	listGuildChannels(guildId: Snowflake): Promise<Channel[]> {
		return this.request('GET', `/v1/guilds/${guildId}/channels`);
	}

	/** POST /v1/channels/{channel_id}/messages */
	createMessage(channelId: Snowflake, body: CreateMessageBody): Promise<Message> {
		return this.request('POST', `/v1/channels/${channelId}/messages`, body);
	}
}
