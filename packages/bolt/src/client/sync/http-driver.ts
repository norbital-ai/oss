import {
	SYNC_CONNECTION_HEADER,
	type CollectionMutationGraph,
	type CollectionMutationIdempotencyKey,
	SyncConnectResponse,
	type SyncConnectRequest
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

export type SyncPushRequest = Readonly<{
	readonly connectionId: string;
	readonly id: CollectionMutationIdempotencyKey;
	readonly graph: CollectionMutationGraph;
}>;

export type SyncHttpDriver = Readonly<{
	readonly connect: (
		connectionId: string,
		request: SyncConnectRequest,
		signal?: AbortSignal
	) => Promise<SyncConnectResponse>;
	readonly push: (request: SyncPushRequest, signal?: AbortSignal) => Promise<void>;
}>;

export type SyncHttpDriverOptions = Readonly<{
	readonly connectUrl: string;
	readonly fetch?: typeof fetch;
	/** Host/runtime-owned command encoding receives the server-issued connection id. */
	readonly push: (request: SyncPushRequest, signal?: AbortSignal) => Promise<void>;
}>;

const terminalStatus = (status: number): boolean =>
	status === 401 || status === 403 || status === 409 || status === 410 || status === 426;

const responseMessage = async (response: Response): Promise<string> => {
	try {
		const payload: unknown = await response.json();
		if (payload !== null && typeof payload === 'object') {
			const message = Reflect.get(payload, 'message');
			if (typeof message === 'string' && message.length > 0) return message;
		}
	} catch {
		// The status text remains the bounded diagnostic for non-JSON host failures.
	}
	return response.statusText || `HTTP ${response.status}`;
};

/** Connect/revalidate HTTP driver. Writes stay host-encoded but share the connection header. */
export const createSyncHttpDriver = (options: SyncHttpDriverOptions): SyncHttpDriver => {
	const request = options.fetch ?? fetch;
	return {
		connect: async (connectionId, input, signal) => {
			const response = await request(options.connectUrl, {
				method: 'POST',
				credentials: 'include',
				headers: {
					'content-type': 'application/json',
					[SYNC_CONNECTION_HEADER]: connectionId
				},
				body: JSON.stringify(input),
				...(signal === undefined ? {} : { signal })
			});
			if (!response.ok) {
				throw new SyncHttpError(
					await responseMessage(response),
					response.status,
					terminalStatus(response.status)
				);
			}
			return Schema.decodeUnknownSync(SyncConnectResponse)(await response.json());
		},
		push: options.push
	};
};
