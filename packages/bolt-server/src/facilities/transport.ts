import {
	FacilityCall,
	TransportRequest,
	TransportResponse,
	type FacilityBinding,
	type TransportFrame,
	type TransportFrameKind
} from '@norbital-ai/bolt-protocol';
import { Effect } from 'effect';
import { randomUUID } from 'node:crypto';
import { makeWireBinding } from '../config.js';

/** The SPI a physical transport implements, mirroring the wire contract's call shape. */
export interface Provider {
	readonly call: (
		metadata: FacilityCall,
		input: TransportRequest,
		signal: AbortSignal
	) => Promise<unknown>;
}
/** Validates transport envelopes without embedding any physical transport semantics. */
export const makeTransportBinding = (
	provider: Provider
): FacilityBinding<TransportRequest, TransportResponse> =>
	makeWireBinding({
		request: TransportRequest,
		response: TransportResponse,
		cancelled: { code: 'transport.cancelled', message: 'Transport call was cancelled' },
		failed: { code: 'transport.failed', message: 'Transport provider operation failed' },
		invoke: provider.call.bind(provider)
	});

/** One open connection's buffered state, carried by the in-memory registry. */
interface MemoryConnection {
	readonly frames: Array<TransportFrame>;
	readonly closed: boolean;
	/** The topic it was opened on, when it was opened on one. `Publish` addresses connections by this. */
	readonly topic: string | undefined;
}

/** Appends a frame to one connection, deriving the cursor from that connection's own sequence. */
const appended = (
	connectionId: string,
	connection: MemoryConnection,
	kind: TransportFrameKind,
	bytes: Uint8Array
): MemoryConnection => {
	const sequence = connection.frames.length;
	return {
		...connection,
		frames: [...connection.frames, { sequence, kind, bytes, cursor: `${connectionId}:${sequence}` }]
	};
};

/** Creates an in-memory transport registry for development, tests, and scale-to-zero hosts. */
export const makeMemoryTransport = (
	options: {
		/** Mints the connection identifiers; injectable so tests can grow deterministic ids. */
		readonly randomId?: () => string;
	} = {}
): {
	readonly binding: FacilityBinding<TransportRequest, TransportResponse>;
	readonly close: () => Promise<void>;
	readonly activeConnections: () => number;
} => {
	const connections = new Map<string, MemoryConnection>();
	const randomId = options.randomId ?? randomUUID;

	const provider: Provider = {
		call: (_metadata, input, signal) =>
			Effect.runPromise(
				Effect.gen(function* () {
					if (signal.aborted) return yield* Effect.fail(signal.reason);

					if (input._tag === 'Open') {
						const connectionId = randomId();
						connections.set(connectionId, {
							frames: [],
							closed: false,
							topic: input.topic
						});
						return { connectionId };
					}

					if (input._tag === 'Publish') {
						// Addressed by topic, because the caller is a stateless invocation that never held a
						// connection. Reaching nobody is an ordinary answer rather than a failure: a workspace
						// with no open tab is the common case, and failing there would make it look broken.
						let delivered = 0;
						for (const [connectionId, connection] of connections) {
							if (connection.closed || connection.topic !== input.topic) continue;
							connections.set(
								connectionId,
								appended(connectionId, connection, input.kind, input.bytes)
							);
							delivered += 1;
						}
						return { delivered };
					}

					const connection = connections.get(input.connectionId);
					if (connection === undefined) {
						return yield* Effect.fail(new Error('Transport connection is not open'));
					}

					if (input._tag === 'Send') {
						if (connection.closed) {
							return yield* Effect.fail(new Error('Transport connection is closed'));
						}
						connections.set(
							input.connectionId,
							appended(input.connectionId, connection, input.kind, input.bytes)
						);
						return {};
					}

					if (input._tag === 'Pull') {
						const afterIndex =
							input.afterCursor === undefined
								? -1
								: connection.frames.findIndex((frame) => frame.cursor === input.afterCursor);
						const start = afterIndex + 1;
						const frames = connection.frames.slice(start, start + input.maxFrames);
						return {
							frames,
							...(connection.closed && start + frames.length >= connection.frames.length
								? { closed: true }
								: {})
						};
					}

					connections.set(input.connectionId, { ...connection, closed: true });
					return { closed: true };
				})
			)
	};

	return {
		binding: makeTransportBinding(provider),
		close: () => Effect.runPromise(Effect.sync(() => connections.clear())),
		activeConnections: () => connections.size
	};
};
