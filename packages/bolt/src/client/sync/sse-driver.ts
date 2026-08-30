import {
	SyncApplyFrame,
	SyncReadyFrame,
	type SyncApplyFrame as SyncApplyFrameType,
	type SyncReadyFrame as SyncReadyFrameType
} from '@norbital-ai/bolt-protocol';
import { Schema } from 'effect';

export type EventSourceLike = {
	readonly addEventListener: (
		type: string,
		listener: (event: Readonly<{ readonly data?: string }>) => void
	) => void;
	readonly close: () => void;
	onerror: ((event: unknown) => void) | null;
};

export type SyncSseDriver = Readonly<{
	readonly close: () => void;
}>;

export type SyncSseDriverOptions = Readonly<{
	readonly url: string;
	readonly source?: (url: string) => EventSourceLike;
	readonly maxBufferedFrames?: number;
	readonly onReady: (frame: SyncReadyFrameType) => void | Promise<void>;
	readonly onFrame: (frame: SyncApplyFrameType) => void | Promise<void>;
	readonly onDisconnect: (cause: Error) => void;
}>;

const eventData = (event: unknown): string | undefined => {
	if (event === null || typeof event !== 'object' || !('data' in event)) return undefined;
	const data = Reflect.get(event, 'data');
	return data === undefined ? undefined : String(data);
};

const browserEventSource = (url: string): EventSourceLike => {
	const source = new EventSource(url, { withCredentials: true });
	return {
		addEventListener: (type, listener) =>
			source.addEventListener(type, (event) => {
				const data = eventData(event);
				listener(data === undefined ? {} : { data });
			}),
		close: () => source.close(),
		set onerror(listener: ((event: unknown) => void) | null) {
			source.onerror = listener;
		}
	};
};

const decodeReady = (data: string | undefined): SyncReadyFrameType =>
	Schema.decodeUnknownSync(SyncReadyFrame)(JSON.parse(data ?? ''));

const decodeApply = (data: string | undefined): SyncApplyFrameType =>
	Schema.decodeUnknownSync(SyncApplyFrame)(JSON.parse(data ?? ''));

/**
 * Opens the one browser stream and preserves event order even when its consumer is asynchronous.
 * Overflow closes the connection: a reconnect handshake is the bounded, integrity-preserving
 * fallback and is strictly safer than dropping an apply frame.
 */
export const openSyncSse = (options: SyncSseDriverOptions): SyncSseDriver => {
	const source = (options.source ?? browserEventSource)(options.url);
	const limit = Math.max(1, Math.floor(options.maxBufferedFrames ?? 64));
	const queue: Array<() => Promise<void>> = [];
	let draining = false;
	let closed = false;
	let ready = false;

	const fail = (cause: unknown): void => {
		if (closed) return;
		closed = true;
		queue.length = 0;
		source.close();
		options.onDisconnect(cause instanceof Error ? cause : new Error(String(cause)));
	};

	const drain = (): void => {
		if (draining || closed) return;
		draining = true;
		void (async () => {
			try {
				for (;;) {
					const next = queue.shift();
					if (next === undefined || closed) return;
					await next();
				}
			} catch (cause) {
				fail(cause);
			} finally {
				draining = false;
				if (queue.length > 0 && !closed) drain();
			}
		})();
	};

	const enqueue = (task: () => void | Promise<void>): void => {
		if (closed) return;
		if (queue.length >= limit) {
			fail(new Error(`Sync stream exceeded its ${limit}-frame browser buffer`));
			return;
		}
		queue.push(async () => task());
		drain();
	};

	source.addEventListener('ready', (event) => {
		if (ready) {
			fail(new Error('Sync stream sent more than one ready frame'));
			return;
		}
		try {
			const frame = decodeReady(eventData(event));
			ready = true;
			enqueue(() => options.onReady(frame));
		} catch (cause) {
			fail(cause);
		}
	});
	source.addEventListener('apply', (event) => {
		if (!ready) {
			fail(new Error('Sync stream sent an apply frame before ready'));
			return;
		}
		try {
			const frame = decodeApply(eventData(event));
			enqueue(() => options.onFrame(frame));
		} catch (cause) {
			fail(cause);
		}
	});
	source.onerror = () => fail(new Error('Sync event stream disconnected'));

	return {
		close: () => {
			if (closed) return;
			closed = true;
			queue.length = 0;
			source.close();
		}
	};
};
