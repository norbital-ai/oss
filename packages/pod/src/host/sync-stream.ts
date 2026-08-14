/**
 * Host-owned sync SSE pump. The browser talks to the host; the host LISTENs on the
 * tenant database and writes frames. Policy-scoped diffs are one short guest function
 * (`sync/diff`). The guest never holds this socket.
 */
import { z } from 'zod';

const cursorSchema = z.object({
	xid: z.string(),
	seq: z.string()
});

const syncDiffSchema = z.object({
	seq: z.string(),
	xid: z.string(),
	collection: z.string(),
	action: z.enum(['insert', 'update', 'delete', 'leave']),
	id: z.string(),
	version: z.number().nullable(),
	row: z.record(z.string(), z.unknown()).optional()
});

const diffBatchSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('reset'), reason: z.literal('cursor_too_old') }),
	z.object({ type: z.literal('scope-reset'), cursor: cursorSchema }),
	z.object({ type: z.literal('cursor'), cursor: cursorSchema }),
	z.object({ type: z.literal('diffs'), diffs: z.array(syncDiffSchema), cursor: cursorSchema }),
	z.object({ type: z.literal('idle'), cursor: cursorSchema })
]);

export type HostSyncStreamInput = {
	readonly path: string;
	readonly signal?: AbortSignal;
	readonly pullDiff: (path: string) => Promise<{ status: number; bodyText: string }>;
	readonly subscribe: (wake: () => void) => () => void;
};

export type HostSyncStreamResponse = {
	status: number;
	headers: Record<string, string>;
	body: ReadableStream<Uint8Array>;
	cancel: () => void;
};

const HORIZON_SETTLE_MS = 25;
const HORIZON_SETTLE_ATTEMPTS = 20;

/** True for the host-owned `/_runtime/sync/stream` path. Guest handlePodRequest must not see it. */
export function isHostSyncStreamPath(requestPath: string): boolean {
	const pathname = requestPath.split('?')[0] ?? requestPath;
	return pathname === '/_runtime/sync/stream' || pathname.endsWith('/sync/stream');
}

/** Serve `/_runtime/sync/stream` as a host ReadableStream. */
export function serveHostSyncStream(input: HostSyncStreamInput): HostSyncStreamResponse {
	const url = new URL(input.path, 'http://tenant.local');
	const collections = url.searchParams.getAll('collection');
	const encoder = new TextEncoder();
	const abort = new AbortController();
	if (input.signal?.aborted) abort.abort();
	else input.signal?.addEventListener('abort', () => abort.abort(), { once: true });

	let wake: (() => void) | null = null;
	const unsubscribe = input.subscribe(() => {
		wake?.();
	});

	const waitForNotify = (): Promise<void> =>
		new Promise((resolve) => {
			if (abort.signal.aborted) {
				resolve();
				return;
			}
			const finish = () => {
				wake = null;
				abort.signal.removeEventListener('abort', finish);
				resolve();
			};
			wake = finish;
			abort.signal.addEventListener('abort', finish, { once: true });
		});

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (payload: string): boolean => {
				if (abort.signal.aborted) return false;
				try {
					controller.enqueue(encoder.encode(payload));
					return true;
				} catch {
					abort.abort();
					return false;
				}
			};
			send('retry: 3000\n\n');
			let settling = HORIZON_SETTLE_ATTEMPTS;
			let announcedSynced = false;
			let cursor = url.searchParams.get('cursor') ?? '';
			try {
				while (!abort.signal.aborted) {
					const diffPath = syncDiffPath(url.pathname, cursor, collections);
					const pulled = await input.pullDiff(diffPath);
					if (abort.signal.aborted) break;
					if (pulled.status >= 400) {
						send(
							`event: error\ndata: ${JSON.stringify({ message: pulled.bodyText.slice(0, 300) })}\n\n`
						);
						break;
					}
					const parsed = diffBatchSchema.safeParse(safeJson(pulled.bodyText));
					if (!parsed.success) {
						send(
							`event: error\ndata: ${JSON.stringify({ message: 'sync/diff returned an unreadable batch' })}\n\n`
						);
						break;
					}
					const batch = parsed.data;
					switch (batch.type) {
						case 'reset':
							send(`event: reset\ndata: ${JSON.stringify({ reason: batch.reason })}\n\n`);
							return;
						case 'scope-reset':
							send(`event: scope-reset\ndata: ${JSON.stringify(batch.cursor)}\n\n`);
							return;
						case 'cursor':
							if (!send(`event: cursor\ndata: ${JSON.stringify(batch.cursor)}\n\n`)) return;
							cursor = encodeCursor(batch.cursor);
							settling = HORIZON_SETTLE_ATTEMPTS;
							announcedSynced = false;
							continue;
						case 'diffs': {
							const frames = batch.diffs
								.map((diff) => `data: ${JSON.stringify(diff)}\n\n`)
								.join('');
							if (!send(frames)) return;
							cursor = encodeCursor(batch.cursor);
							settling = HORIZON_SETTLE_ATTEMPTS;
							announcedSynced = false;
							continue;
						}
						case 'idle':
							if (settling > 0) {
								settling -= 1;
								await delay(HORIZON_SETTLE_MS, abort.signal);
								continue;
							}
							if (!announcedSynced) {
								send('event: synced\ndata: {}\n\n');
								announcedSynced = true;
							}
							await waitForNotify();
							settling = HORIZON_SETTLE_ATTEMPTS;
							continue;
						default: {
							const unhandled: never = batch;
							throw new Error(`Unhandled sync/diff batch: ${JSON.stringify(unhandled)}`);
						}
					}
				}
			} catch (error) {
				if (!abort.signal.aborted) {
					send(
						`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`
					);
				}
			} finally {
				unsubscribe();
				try {
					controller.close();
				} catch {
					// client already closed
				}
			}
		},
		cancel() {
			abort.abort();
			unsubscribe();
		}
	});

	return {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		},
		body: stream,
		cancel: () => {
			abort.abort();
			unsubscribe();
		}
	};
}

function syncDiffPath(streamPath: string, cursor: string, collections: readonly string[]): string {
	const diff = new URL(streamPath.replace(/\/stream\/?$/, '/diff'), 'http://tenant.local');
	if (cursor) diff.searchParams.set('cursor', cursor);
	for (const collection of collections) diff.searchParams.append('collection', collection);
	return `${diff.pathname}${diff.search}`;
}

function encodeCursor(cursor: { xid: string; seq: string }): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function safeJson(text: string): unknown {
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return null;
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}
