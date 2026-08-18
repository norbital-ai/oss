import {
	FacilityCall,
	TransportRequest,
	TransportResponse,
	failure,
	makeWireError,
	success,
	type FacilityBinding,
	type TransportFrame,
	type TransportFrameKind
} from '@norbital-ai/bolt-protocol';
import { Effect, Schema } from 'effect';
import { randomUUID } from 'node:crypto';

// stupidity:allow AL10 -- provider SPI stays beside its wire adapter in the required 14-file architecture
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
): FacilityBinding<TransportRequest, TransportResponse> => ({
	call: (unsafeMetadata, unsafeInput, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const metadata = yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
				const input = yield* Schema.decodeUnknownEffect(TransportRequest)(unsafeInput);
				if (signal.aborted) {
					return failure(makeWireError('transport.cancelled', 'Transport call was cancelled'));
				}
				return success(
					yield* Schema.decodeUnknownEffect(TransportResponse)(
						yield* Effect.tryPromise(() => provider.call(metadata, input, signal))
					)
				);
			}).pipe(
				Effect.catch(() =>
					Effect.succeed(
						failure(
							makeWireError('transport.failed', 'Transport provider operation failed', {
								retryable: !signal.aborted,
								outcome: signal.aborted ? 'unknown' : 'known'
							})
						)
					)
				)
			)
		)
});

// stupidity:allow AL10 -- in-memory connection state stays beside its provider in the required 14-file architecture
interface MemoryConnection {
	readonly frames: Array<TransportFrame>;
	readonly closed: boolean;
	/** The topic it was opened on, when it was opened on one. `Publish` addresses connections by this. */
	readonly topic?: string;
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
export const makeMemoryTransport = (): {
	readonly binding: FacilityBinding<TransportRequest, TransportResponse>;
	readonly close: () => Promise<void>;
	readonly activeConnections: () => number;
} => {
	const connections = new Map<string, MemoryConnection>();

	const provider: Provider = {
		call: async (_metadata, input, signal) => {
			if (signal.aborted) throw signal.reason;

			if (input._tag === 'Open') {
				const connectionId = randomUUID();
				connections.set(connectionId, {
					frames: [],
					closed: false,
					...(input.topic === undefined ? {} : { topic: input.topic })
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
				throw new Error('Transport connection is not open');
			}

			if (input._tag === 'Send') {
				if (connection.closed) throw new Error('Transport connection is closed');
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
		}
	};

	return {
		binding: makeTransportBinding(provider),
		close: async () => {
			connections.clear();
		},
		activeConnections: () => connections.size
	};
};

/** Exposes explicit in-memory transport binding construction. */
export const TransportFacilities = {
	make: makeTransportBinding,
	memory: makeMemoryTransport
};
