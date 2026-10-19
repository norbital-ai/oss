import { Effect, Schema } from 'effect';
import { until } from './kit.ts';
// The realm's Baileys patch, probed in the installed library (both workspaces apply the same file): a decrypted message is
// offered to `beforeReceipt`, cleaned, before its receipt leaves; a refusal sends no receipt and no nack and ends the
// socket with 428 so WhatsApp delivers the message again. If the patch is missing, the hook is never called and this fails.
import { describe, expect, it } from '@effect/vitest';

type Frame = Uint8Array;
type Sock = {
	ws: { socket: unknown; emit(event: string, node: unknown): boolean };
	ev: {
		on(
			event: string,
			listener: (u: {
				connection?: string;
				lastDisconnect?: { error?: { output?: { statusCode?: number } } };
			}) => void
		): void;
	};
	end(error: Error | undefined): Promise<void>;
};
type Baileys = {
	default(config: object): Sock;
	initAuthCreds(): { me?: { id: string; name: string } };
	proto: { Message: { encode(m: object): { finish(): Uint8Array } } };
};
const quiet = {
	level: 'silent',
	child: () => quiet,
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error() {}
};

/** A real socket whose wire is a fake: every frame it would send is kept, and nothing reaches WhatsApp. */
const probe = Effect.fn('Baileys.patchFixture')(function* (
	beforeReceipt: (
		message: { key: { id?: string; remoteJid?: string }; message?: { conversation?: string } },
		type: string
	) => Promise<void>
) {
	const b = yield* Schema.decodeUnknownEffect(
		Schema.declare<Baileys>(
			(value): value is Baileys =>
				typeof value === 'object' &&
				value !== null &&
				'default' in value &&
				typeof value.default === 'function' &&
				'initAuthCreds' in value &&
				typeof value.initAuthCreds === 'function' &&
				'proto' in value &&
				typeof value.proto === 'object' &&
				value.proto !== null &&
				'Message' in value.proto &&
				(typeof value.proto.Message === 'object' || typeof value.proto.Message === 'function') &&
				value.proto.Message !== null &&
				'encode' in value.proto.Message &&
				typeof value.proto.Message.encode === 'function'
		)
	)(yield* Effect.tryPromise(() => import('@whiskeysockets/baileys')));
	const creds = b.initAuthCreds();
	creds.me = { id: '6580000000:1@s.whatsapp.net', name: 'Probe' };
	const sock = b.default({
		auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
		logger: quiet,
		version: [2, 3000, 1],
		waWebSocketUrl: 'ws://127.0.0.1:1',
		beforeReceipt
	});
	type NativeSocket = {
		removeAllListeners(): void;
		on(e: string, f: () => void): void;
		terminate(): void;
	};
	const real = yield* Schema.decodeUnknownEffect(
		Schema.declare<NativeSocket>(
			(value): value is NativeSocket =>
				typeof value === 'object' &&
				value !== null &&
				'removeAllListeners' in value &&
				typeof value.removeAllListeners === 'function' &&
				'on' in value &&
				typeof value.on === 'function' &&
				'terminate' in value &&
				typeof value.terminate === 'function'
		)
	)(sock.ws.socket);
	real.removeAllListeners();
	real.on('error', () => {});
	real.terminate();
	const frames: Frame[] = [];
	let closed: (() => void) | undefined;
	sock.ws.socket = {
		readyState: 1,
		send: (data: Frame, cb?: () => void) => {
			frames.push(data);
			cb?.();
		},
		once: (e: string, f: () => void) => {
			if (e === 'close') closed = f;
		},
		close: () => closed?.()
	};
	const ends: (number | undefined)[] = [];
	sock.ev.on('connection.update', (u) => {
		if (u.connection === 'close') ends.push(u.lastDisconnect?.error?.output?.statusCode);
	});
	// a LID sender: Baileys decrypts for it without asking the server for a mapping first
	const message = (id: string) => ({
		tag: 'message',
		attrs: { id, from: '113377445566@lid', t: '1790000000', type: 'text', notify: 'Ben' },
		content: [
			{
				tag: 'plaintext',
				attrs: {},
				content: b.proto.Message.encode({ conversation: 'hello' }).finish()
			}
		]
	});
	yield* Effect.addFinalizer(() =>
		Effect.tryPromise(() => sock.end(undefined)).pipe(Effect.ignore)
	);
	return { sock, frames, ends, deliver: (id: string) => sock.ws.emit('CB:message', message(id)) };
});

describe('the Baileys patch', () => {
	it.live('offers each message to beforeReceipt before its receipt is sent', () =>
		Effect.gen(function* () {
			const offered: {
				id: string | undefined;
				text: string | undefined;
				type: string;
				framesBefore: number;
			}[] = [];
			const p = yield* probe(async (m, type) => {
				offered.push({
					id: m.key.id,
					text: m.message?.conversation,
					type,
					framesBefore: p.frames.length
				});
			});
			p.deliver('PROBE1');
			yield* until(() => p.frames.length > 0);
			expect(offered).toEqual([{ id: 'PROBE1', text: 'hello', type: 'notify', framesBefore: 0 }]);
			expect(p.frames).toHaveLength(1);
			yield* Effect.tryPromise(() => p.sock.end(undefined));
		})
	);
	it.live('a refusal sends nothing back and ends the socket with 428', () =>
		Effect.gen(function* () {
			let offered = 0;
			const p = yield* probe(async () => {
				offered++;
				throw new Error('not stored');
			});
			p.deliver('PROBE2');
			yield* until(() => p.ends.length > 0);
			expect(offered).toBe(1);
			expect(p.ends).toEqual([428]);
			expect(p.frames).toEqual([]);
		})
	);
});
