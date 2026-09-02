import {
	SYNC_CONNECTION_HEADER,
	SyncConnectRequest,
	SyncConnectResponse,
	SyncExtendPrefixResponse,
	type CollectionMutateRequest,
	type SyncExtendPrefixRequest
} from '@norbital-ai/bolt-protocol';
import { Schema } from 'effect';

export class SyncHttpError extends Error {
	readonly status: number;
	readonly terminal: boolean;

	constructor(message: string, status: number, terminal: boolean) {
		super(message);
		this.name = 'SyncHttpError';
		this.status = status;
		this.terminal = terminal;
	}
}

export type SyncPushRequest = Readonly<{ readonly connectionId: string } & CollectionMutateRequest>;

export type SyncHttpDriver = Readonly<{
	readonly register: (
		connectionId: string,
		request: SyncConnectRequest,
		signal?: AbortSignal
	) => Promise<SyncConnectResponse>;
	readonly extend: (
		connectionId: string,
		request: SyncExtendPrefixRequest,
		signal?: AbortSignal
	) => Promise<SyncExtendPrefixResponse>;
	readonly push: (request: SyncPushRequest, signal?: AbortSignal) => Promise<void>;
}>;

export type SyncHttpDriverOptions = Readonly<{
	readonly registrationUrl: string;
	readonly extensionUrl: string;
	readonly fetch?: typeof fetch;
	readonly authorization?: () => string;
	readonly push: (request: SyncPushRequest, signal?: AbortSignal) => Promise<void>;
}>;

/**
 * Statuses a retry cannot change.
 *
 * 400 is here because a registration the host calls malformed — an authored query the planner
 * refuses, a body it cannot decode — will be refused identically every time. Retrying it on the
 * transport backoff left every query on the page pending forever, with the refusal's sentence
 * read once and thrown away; failing them with it is what lets a person read what was wrong.
 */
const terminalStatus = (status: number): boolean =>
	status === 400 || status === 401 || status === 403 || status === 410 || status === 426;

const responseMessage = async (response: Response): Promise<string> => {
	try {
		const payload: unknown = await response.json();
		if (payload !== null && typeof payload === 'object') {
			const message = Reflect.get(payload, 'message');
			if (typeof message === 'string' && message.length > 0) return message;
		}
	} catch {
		/* non-JSON host failures use status text */
	}
	return response.statusText || `HTTP ${response.status}`;
};

const post = async (
	request: typeof fetch,
	url: string,
	connectionId: string,
	body: unknown,
	authorization: string | undefined,
	signal?: AbortSignal
): Promise<unknown> => {
	const response = await request(url, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'content-type': 'application/json',
			[SYNC_CONNECTION_HEADER]: connectionId,
			...(authorization === undefined || authorization.length === 0
				? {}
				: { authorization })
		},
		body: JSON.stringify(body),
		...(signal === undefined ? {} : { signal })
	});
	if (!response.ok) {
		throw new SyncHttpError(
			await responseMessage(response),
			response.status,
			terminalStatus(response.status)
		);
	}
	return response.json();
};

export const createSyncHttpDriver = (options: SyncHttpDriverOptions): SyncHttpDriver => {
	const request = options.fetch ?? fetch;
	return {
		register: async (connectionId, input, signal) =>
			Schema.decodeUnknownSync(SyncConnectResponse)(
				await post(request, options.registrationUrl, connectionId, input, options.authorization?.(), signal)
			),
		extend: async (connectionId, input, signal) =>
			Schema.decodeUnknownSync(SyncExtendPrefixResponse)(
				await post(request, options.extensionUrl, connectionId, input, options.authorization?.(), signal)
			),
		push: options.push
	};
};
