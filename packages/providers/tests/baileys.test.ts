// WhatsApp Web (Baileys): the message codec, and the link over a fake of the patched socket — pairing by QR or code,
// the key store over the instance's credentials (nothing before pairing names the account, one statement per keys.set,
// the creds coalesced and written before the 515 restart), the ingest gate (stored before the receipt, retried in place,
// unreceipted on refusal or close), the disconnect classifier, a fence that stops the link for good, and the send shape.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Random, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { LinkClosed, ProviderUnavailable } from '../src/errors.ts';
import { Fenced, type Json } from '@norbital-ai/bolt/engine';
import {
	baileysGroupReceipt,
	baileysReceipt,
	classify,
	whatsappMessage
} from '../src/baileys/index.ts';
import { CREDS, fake, ME, raw } from './baileys-fake.ts';
import { fakeFetch, file, host, messagesOf, until, type HostOptions } from './kit.ts';

describe('WhatsApp (Baileys) messages', () => {
	it('a receipt on our own message is its delivery report; anything else is not', () => {
		const key = { id: 'M1', remoteJid: '659@s.whatsapp.net', fromMe: true };
		expect(baileysReceipt({ key, update: { status: 2 } }, 1_790_000_000_000)).toMatchObject({
			providerId: 'M1',
			report: { kind: 'sent', provider: 'baileys' }
		});
		expect(baileysReceipt({ key, update: { status: 3 } }, 1_790_000_000_000)?.report.kind).toBe(
			'delivered'
		);
		expect(baileysReceipt({ key, update: { status: 4 } }, 1_790_000_000_000)?.report.kind).toBe(
			'read'
		);
		expect(baileysReceipt({ key, update: { status: 0 } }, 1_790_000_000_000)?.report).toMatchObject(
			{ kind: 'failed', reason: 'WhatsApp reported an error' }
		);
		expect(baileysReceipt({ key, update: { status: 1 } }, 1_790_000_000_000)).toBeNull();
		expect(
			baileysReceipt({ key: { ...key, fromMe: false }, update: { status: 4 } }, 1_790_000_000_000)
		).toBeNull();
		expect(baileysReceipt({ key, update: { starred: true } }, 1_790_000_000_000)).toBeNull();
	});
	it("a group member's receipt on our message is delivered, then read", () => {
		const key = { id: 'G1', remoteJid: '1203@g.us', fromMe: true };
		expect(
			baileysGroupReceipt(
				{ key, receipt: { userJid: '659@s.whatsapp.net', receiptTimestamp: 1 } },
				1_790_000_000_000
			)
		).toMatchObject({ providerId: 'G1', report: { kind: 'delivered' } });
		expect(
			baileysGroupReceipt(
				{ key, receipt: { userJid: '659@s.whatsapp.net', readTimestamp: 2 } },
				1_790_000_000_000
			)?.report.kind
		).toBe('read');
		expect(
			baileysGroupReceipt(
				{ key: { ...key, fromMe: false }, receipt: { readTimestamp: 2 } },
				1_790_000_000_000
			)
		).toBeNull();
	});
	const self = '6580000000:3@s.whatsapp.net';
	/** Our LID, the identity WhatsApp actually names in a group mention; `self` is the phone JID it prints as. */
	const MY_LID = '113377445566:4@lid';
	const wa = (key: object, message: object, extra: object = {}) => ({
		key: { id: 'M1', ...key },
		messageTimestamp: 1_790_000_000,
		pushName: 'Ben',
		message,
		...extra
	});
	it('a personal account includes what it sent, as outbound', () => {
		expect(
			whatsappMessage(
				wa({ remoteJid: '659@s.whatsapp.net', fromMe: true }, { conversation: 'sent quote' }),
				self,
				{ includeSent: true }
			)
		).toMatchObject({ direction: 'outbound', text: 'sent quote' });
	});
	it('keeps attachment-only messages and uses the supplied phone identity instead of an opaque LID', () => {
		expect(
			whatsappMessage(
				wa(
					{ remoteJid: 'opaque@lid', remoteJidAlt: '6591009037@s.whatsapp.net' },
					{ documentMessage: { fileName: 'scope.pdf' } }
				),
				self,
				{ includeSent: true }
			)
		).toMatchObject({
			from: { handle: '6591009037@s.whatsapp.net' },
			text: '[Document: scope.pdf]'
		});
	});
	it('our own echo and empty messages are not messages', () => {
		expect(
			whatsappMessage(
				wa({ remoteJid: '659@s.whatsapp.net', fromMe: true }, { conversation: 'x' }),
				self
			)
		).toBeNull();
		expect(whatsappMessage({ key: { id: 'M1', remoteJid: 'x' } }, self)).toBeNull();
	});
	it('a group message names its participant; a mention of our number or a quote of our message addresses us', () => {
		const g = { remoteJid: '1203@g.us', participant: '6591234567:14@s.whatsapp.net' };
		expect(whatsappMessage(wa(g, { conversation: 'running late' }), self)).toMatchObject({
			thread: '1203@g.us',
			group: true,
			invocation: 'ambient',
			from: { handle: '6591234567:14@s.whatsapp.net', name: 'Ben' }
		});
		expect(
			whatsappMessage(
				wa(g, {
					extendedTextMessage: {
						text: '@bot done',
						contextInfo: { mentionedJid: ['6580000000@s.whatsapp.net'] }
					}
				}),
				self
			)!['invocation']
		).toBe('mention');
		expect(
			whatsappMessage(
				wa(g, {
					extendedTextMessage: {
						text: 'ok',
						contextInfo: { participant: '6580000000@s.whatsapp.net', stanzaId: 'X' }
					}
				}),
				self
			)
		).toMatchObject({ invocation: 'reply', replyTo: 'X' });
		expect(
			whatsappMessage(
				wa(g, {
					extendedTextMessage: {
						text: 'ok',
						contextInfo: { participant: '6599999999@s.whatsapp.net' }
					}
				}),
				self
			)!['invocation']
		).toBe('ambient');
	});
	it('a mention by our LID addresses us too, which is what WhatsApp actually sends', () => {
		// WhatsApp addresses a linked device by LID, so `mentionedJid` carries the LID and not the phone JID the number
		// prints as. Matching only the phone JID reads every real mention as ambient — the linked device never wakes.
		const g = { remoteJid: '1203@g.us', participant: '6591234567:14@s.whatsapp.net' };
		const mentioned = (jid: string) =>
			whatsappMessage(
				wa(g, { extendedTextMessage: { text: '@bot done', contextInfo: { mentionedJid: [jid] } } }),
				self,
				{ lid: MY_LID }
			)!['invocation'];
		expect(mentioned('6580000000@s.whatsapp.net')).toBe('mention');
		expect(mentioned(MY_LID)).toBe('mention');
		expect(mentioned('999999999999@lid')).toBe('ambient');
		// every mention reaches the engine as `mentions`, ours or not
		expect(
			whatsappMessage(
				wa(g, {
					extendedTextMessage: {
						text: '@a @b',
						contextInfo: { mentionedJid: [MY_LID, '999999999999@lid'] }
					}
				}),
				self,
				{ lid: MY_LID }
			)
		).toMatchObject({ mentions: [MY_LID, '999999999999@lid'] });
	});
	it('a revoke tombstones its target; an edit converges its target text', () => {
		const dm = { remoteJid: '6591234567@s.whatsapp.net' };
		expect(
			whatsappMessage(wa(dm, { protocolMessage: { type: 0, key: { id: 'OLD' } } }), self)
		).toMatchObject({ id: 'OLD', deleted: true });
		expect(
			whatsappMessage(
				wa(dm, {
					protocolMessage: {
						type: 14,
						key: { id: 'OLD' },
						editedMessage: { conversation: 'fixed' }
					}
				}),
				self
			)
		).toMatchObject({
			id: 'OLD',
			text: 'fixed',
			version: new Date(1_790_000_000_000).toISOString()
		});
		expect(whatsappMessage(wa(dm, { imageMessage: { caption: 'photo' } }), self)).toMatchObject({
			text: 'photo',
			invocation: 'direct'
		});
	});
	it('reads each disconnect: an end that needs the operator, a restart now, or a jittered retry', () => {
		expect(classify(401, true)).toMatchObject({ kind: 'terminal', code: 'loggedOut', clear: true });
		expect(classify(419, true)).toMatchObject({ kind: 'terminal', code: 'loggedOut', clear: true });
		expect(classify(403, true)).toMatchObject({ kind: 'terminal', code: 'forbidden' });
		expect(classify(411, true)).toMatchObject({ kind: 'terminal', code: 'unsupported' });
		expect(classify(440, true)).toMatchObject({ kind: 'terminal', code: 'replaced' });
		expect(classify(408, false)).toMatchObject({ kind: 'terminal', code: 'pairingExpired' });
		expect(classify(408, true)).toEqual({ kind: 'backoff' });
		expect(classify(428, true)).toEqual({ kind: 'backoff' });
		expect(classify(500, true)).toEqual({ kind: 'backoff' });
		expect(classify(undefined, true)).toEqual({ kind: 'backoff' });
		expect(classify(503, true)).toEqual({ kind: 'backoff', floor: 30_000, cap: 600_000 });
		expect(classify(515, false)).toEqual({ kind: 'restart' });
		expect(classify(463, true)).toMatchObject({ kind: 'terminal', code: 'failure:463' });
	});
});

const open = Effect.fn('WhatsAppTest.open')(function* (
	f: ReturnType<typeof fake>,
	stored: { [name: string]: Json } = {},
	o: HostOptions = {}
) {
	const h = yield* host(f.provider, fakeFetch([]), stored, o);
	if (stored['creds'] !== undefined) yield* f.socket();
	return h;
});
const wait = (ms: number) => Effect.sleep(ms);
const sdk = <A>(read: () => Promise<A>) =>
	Effect.tryPromise({
		try: read,
		catch: (error) =>
			error instanceof LinkClosed
				? error
				: new ProviderUnavailable({
						message: error instanceof Error ? error.message : String(error)
					})
	});
const creds = Schema.decodeUnknownSync(Schema.JsonObject)(CREDS);

describe('the WhatsApp Web link', () => {
	it.live('pairs by QR, or by code for a phone; refuses a malformed phone', () =>
		Effect.gen(function* () {
			const f = fake(),
				h = yield* open(f);
			expect(h.status).toEqual({ state: 'unpaired' });
			expect(yield* Effect.flip(h.link.pair!({ phone: '12' }))).toMatchObject({
				message: expect.stringMatching(/digits, country code first/)
			});
			yield* h.link.pair!({});
			yield* f.socket(0);
			f.opened[0]!.ev.emit('connection.update', { qr: 'QR-DATA' });
			yield* until(() => h.pairing?.kind === 'qr');
			expect([h.status, h.pairing]).toEqual([
				{ state: 'pairing' },
				{ kind: 'qr', value: 'QR-DATA' }
			]);
			yield* h.link.pair!({ phone: '+65 8000 0000' });
			yield* f.socket(1);
			expect(f.opened[0]!.ended).toBe(true);
			f.opened[1]!.ev.emit('connection.update', { qr: 'QR2' });
			yield* until(() => h.pairing?.kind === 'code');
			expect(h.pairing).toEqual({ kind: 'code', value: 'ABCD-1234' });
			yield* h.link.close ?? Effect.void;
		})
	);
	it.live(
		'persists nothing before pairing names the account; then the creds and every key in one write, each keys.set one statement after',
		() =>
			Effect.gen(function* () {
				const f = fake(),
					h = yield* open(f);
				yield* h.link.pair!({});
				yield* f.socket(0);
				const s = f.opened[0]!;
				yield* sdk(() => s.config.store.update({ me: { id: ME } })); // a pairing code names the number early: still not paired
				yield* sdk(() => s.config.store.set({ 'pre-key': { '1': { k: 'a' } } }));
				expect(h.writes).toEqual([]);
				expect(s.config.store.get('pre-key', ['1', '2'])).toEqual({ '1': { k: 'a' } });
				yield* sdk(() => s.paired());
				expect(h.writes).toEqual([
					new Map<string, Json>([
						['creds', CREDS],
						['pre-key:1', { k: 'a' }]
					])
				]);
				yield* sdk(() =>
					s.config.store.set({ session: { a: { s: 1 }, b: { s: 2 } }, 'pre-key': { '1': null } })
				);
				expect(h.writes.at(-1)).toEqual(
					new Map<string, Json | null>([
						['session:a', { s: 1 }],
						['session:b', { s: 2 }],
						['pre-key:1', null]
					])
				);
				expect(Object.fromEntries(h.values)).toEqual({
					creds: CREDS,
					'session:a': { s: 1 },
					'session:b': { s: 2 }
				});
				yield* h.link.close ?? Effect.void;
			})
	);
	it.live('coalesces creds updates while one write is in flight, and keeps writes in order', () =>
		Effect.gen(function* () {
			let gate: (() => void) | undefined;
			const f = fake(),
				h = yield* open(
					f,
					{ creds: CREDS },
					{
						write: async (c) => {
							if (c.has('creds') && gate === undefined)
								await new Promise<void>((r) => {
									gate = r;
								});
						}
					}
				);
			const s = f.opened[0]!;
			const first = s.config.store.update({ ...creds, n: 1 });
			yield* until(() => gate !== undefined);
			const second = s.config.store.update({ ...creds, n: 2 }),
				third = s.config.store.update({ ...creds, n: 3 });
			const key = s.config.store.set({ session: { a: { s: 1 } } });
			gate!();
			yield* sdk(() => Promise.all([first, second, third, key]));
			expect(h.writes.map((w) => [...w.keys()].join())).toEqual(['creds', 'creds', 'session:a']);
			expect(h.writes[1]!.get('creds')).toMatchObject({ n: 3 });
			yield* h.link.close ?? Effect.void;
		})
	);
	it.live('515 after pairing: the creds land before the socket that logs in with them', () =>
		Effect.gen(function* () {
			const log: string[] = [];
			const f = fake(log),
				h = yield* open(
					f,
					{},
					{
						write: async (c) => {
							log.push(`write ${[...c.keys()].join()}`);
						}
					}
				);
			yield* h.link.pair!({});
			yield* f.socket(0);
			const s = f.opened[0]!;
			const updating = yield* sdk(() =>
				s.config.store.update({ ...creds, accountSyncCounter: 1 })
			).pipe(Effect.forkChild);
			s.drop(515, 'restart required');
			yield* f.socket(1);
			yield* Fiber.join(updating);
			expect(log).toEqual(['open', 'write creds', 'open']);
			expect(h.status).toMatchObject({ state: 'connecting', detail: 'restarting after pairing' });
			yield* h.link.close ?? Effect.void;
		})
	);
	it.live('resumes from the stored keys: the socket gets the creds, the keys read back', () =>
		Effect.gen(function* () {
			const f = fake(),
				h = yield* open(f, { creds: CREDS, 'session:a': { s: 1 } });
			expect(f.opened).toHaveLength(1);
			expect(f.opened[0]!.config.store.creds).toEqual(CREDS);
			expect(f.opened[0]!.config.store.get('session', ['a'])).toEqual({ a: { s: 1 } });
			expect(h.status).toMatchObject({ state: 'connecting' });
			f.opened[0]!.ready();
			yield* until(() => h.status?.state === 'connected');
			expect(h.status).toEqual({
				state: 'connected',
				account: '6580000000',
				about: { account: '6580000000' }
			});
			yield* h.link.close ?? Effect.void;
		})
	);
	it.live('408 before pairing completes is pairingExpired: terminal, no new socket', () =>
		Effect.gen(function* () {
			const f = fake(),
				h = yield* open(f);
			yield* h.link.pair!({});
			yield* f.socket(0);
			f.opened[0]!.drop(408, 'QR refs attempts ended');
			yield* wait(20);
			expect(f.opened).toHaveLength(1);
			expect(h.status).toMatchObject({
				state: 'error',
				code: 'pairingExpired',
				lastDisconnect: { code: 408, message: 'QR refs attempts ended' }
			});
			// pairing again starts over
			yield* h.link.pair!({});
			yield* f.socket(1);
			expect(f.opened).toHaveLength(2);
			yield* h.link.close ?? Effect.void;
		})
	);
	it.live('440 is replaced: terminal, never a reconnect that would fight the other session', () =>
		Effect.gen(function* () {
			const f = fake(),
				h = yield* open(f, { creds: CREDS });
			f.opened[0]!.ready();
			f.opened[0]!.drop(440, 'Stream Errored (conflict)');
			yield* wait(20);
			expect(f.opened).toHaveLength(1);
			expect(h.status).toMatchObject({ state: 'error', code: 'replaced' });
			yield* h.link.close ?? Effect.void;
		})
	);
	it.live('401 is a logout: the keys are destroyed and the link says pair again', () =>
		Effect.gen(function* () {
			const f = fake(),
				h = yield* open(f, { creds: CREDS, 'session:a': { s: 1 } });
			f.opened[0]!.drop(401, 'logged out');
			yield* until(() => h.status?.state === 'error');
			expect(h.status).toMatchObject({
				code: 'loggedOut',
				error: expect.stringContaining('Pair again')
			});
			expect(Object.fromEntries(h.values)).toEqual({});
			expect(f.opened).toHaveLength(1);
			yield* h.link.close ?? Effect.void;
		})
	);
	it.effect('a drop reconnects with backoff; a refused connect backs off too', () =>
		Effect.gen(function* () {
			const f = fake(),
				h = yield* open(f, { creds: CREDS });
			f.opened[0]!.ready();
			yield* TestClock.withLive(until(() => h.status?.state === 'connected'));
			f.control.refuse = true;
			f.opened[0]!.drop(428, 'Connection Terminated');
			yield* TestClock.withLive(until(() => h.status?.state === 'reconnecting'));
			yield* TestClock.adjust('999 millis');
			expect(f.opened).toHaveLength(1);
			yield* TestClock.adjust('1 millis');
			yield* TestClock.withLive(until(() => h.status?.detail?.includes('no network') === true));
			yield* TestClock.adjust('1999 millis');
			expect(f.opened).toHaveLength(1);
			yield* TestClock.adjust('1 millis');
			yield* f.socket(1);
			expect(h.statuses.filter((s) => s.state === 'reconnecting')).toMatchObject([
				{ detail: 'Connection Terminated', lastDisconnect: { code: 428 } },
				{ detail: expect.stringContaining('no network') }
			]);
			yield* h.link.close ?? Effect.void;
		}).pipe(
			Effect.provideService(Random.Random, { nextDoubleUnsafe: () => 0.5, nextIntUnsafe: () => 0 })
		)
	);
	it.effect(
		'a socket that opens after its open timed out is ended at once, never live beside its retry',
		() =>
			Effect.gen(function* () {
				const f = fake([], { openMs: 30 });
				const started = Promise.withResolvers<void>(),
					lateOpen = Promise.withResolvers<void>();
				f.control.nextOpen = () => {
					started.resolve();
					return lateOpen.promise;
				};
				yield* Effect.addFinalizer(() => Effect.sync(() => lateOpen.resolve()));
				const h = yield* host(f.provider, fakeFetch([]), { creds: CREDS });
				yield* Effect.promise(() => started.promise);
				yield* TestClock.adjust('30 millis');
				yield* TestClock.withLive(until(() => h.status?.detail?.includes('deadline') === true));
				lateOpen.resolve();
				yield* TestClock.withLive(until(() => f.opened.some((socket) => socket.ended)));
				yield* TestClock.adjust('1 second');
				yield* f.socket(1);
				// the late socket ends regardless of which native open resolves first
				const late = f.opened.find((socket) => socket.ended),
					retried = f.opened.find((socket) => !socket.ended);
				if (late === undefined || retried === undefined)
					throw new Error('expected one ended late socket and one retry');
				expect(late.ended).toBe(true);
				expect(retried.ended).toBe(false);
				retried.ready();
				yield* TestClock.withLive(until(() => h.status?.state === 'connected'));
				expect(h.status).toMatchObject({ state: 'connected' });
				yield* h.link.close ?? Effect.void;
			}).pipe(
				Effect.provideService(Random.Random, {
					nextDoubleUnsafe: () => 0.5,
					nextIntUnsafe: () => 0
				})
			)
	);
	it.live('a fenced write stops the link for good: the socket ends, nothing reconnects', () =>
		Effect.gen(function* () {
			const f = fake();
			const h = yield* open(
				f,
				{},
				{
					write: async () => {
						throw new Fenced({ instance: 'desk', message: 'Another host opened this account' });
					}
				}
			);
			yield* h.link.pair!({});
			yield* f.socket(0);
			const s = f.opened[0]!;
			expect(yield* Effect.flip(sdk(() => s.paired()))).toMatchObject({ _tag: 'LinkClosed' });
			yield* until(() => h.status?.state === 'error');
			expect(h.status).toMatchObject({ code: 'replaced' });
			expect(s.ended).toBe(true);
			yield* wait(20);
			expect(f.opened).toHaveLength(1);
			yield* h.link.close ?? Effect.void;
		})
	);
});

describe('the ingest gate', () => {
	it.live('a message is stored before its receipt; a transient refusal is retried in place', () =>
		Effect.gen(function* () {
			let refusals = 1;
			const f = fake(),
				h = yield* open(
					f,
					{ creds: CREDS },
					{
						emit: async (e) => {
							if (e.kind === 'messages' && refusals-- > 0) throw new Error('busy');
						}
					}
				);
			const s = f.opened[0]!;
			s.ready();
			yield* sdk(() => s.deliver(raw('M1', 'hi')));
			expect(s.receipts).toEqual(['M1']);
			expect(messagesOf(h.events)).toMatchObject([{ id: 'M1', text: 'hi', invocation: 'direct' }]);
			yield* h.link.close ?? Effect.void;
		})
	);
	it.live(
		'a refusal past the retry ends the socket unreceipted; the redelivery on the next socket is stored',
		() =>
			Effect.gen(function* () {
				let down = true;
				const f = fake(),
					h = yield* open(
						f,
						{ creds: CREDS },
						{
							emit: async (e) => {
								if (e.kind === 'messages' && down) throw new Error('database unavailable');
							}
						}
					);
				f.opened[0]!.ready();
				yield* sdk(() => f.opened[0]!.deliver(raw('M1')));
				expect(f.opened[0]!.receipts).toEqual([]);
				expect(f.opened[0]!.ended).toBe(true);
				yield* f.socket(1);
				down = false;
				f.opened[1]!.ready();
				yield* sdk(() => f.opened[1]!.deliver(raw('M1'))); // WhatsApp redelivers what was never receipted
				expect(f.opened[1]!.receipts).toEqual(['M1']);
				expect(messagesOf(h.events)).toHaveLength(1);
				yield* h.link.close ?? Effect.void;
			})
	);
	it.live(
		'a graceful close with a message still being stored sends no receipt for it; the next link stores the redelivery',
		() =>
			Effect.gen(function* () {
				const f = fake();
				const h = yield* open(f, { creds: CREDS }, { emit: () => new Promise<void>(() => {}) });
				f.opened[0]!.ready();
				const pending = f.opened[0]!.deliver(raw('M1'));
				yield* wait(10);
				yield* h.link.close ?? Effect.void;
				yield* sdk(() => pending);
				expect(f.opened[0]!.receipts).toEqual([]);
				expect(f.opened[0]!.ended).toBe(true);
				// a new message arriving while it closes is refused too
				yield* sdk(() => f.opened[0]!.deliver(raw('M2')));
				expect(f.opened[0]!.receipts).toEqual([]);
				const g = fake(),
					next = yield* open(g, Object.fromEntries(h.values));
				g.opened[0]!.ready();
				yield* sdk(() => g.opened[0]!.deliver(raw('M1')));
				expect(g.opened[0]!.receipts).toEqual(['M1']);
				expect(messagesOf(next.events)).toMatchObject([{ id: 'M1' }]);
				yield* next.link.close ?? Effect.void;
			})
	);
	it.live('a close waits for a message that lands within its grace, and receipts it', () =>
		Effect.gen(function* () {
			let land: (() => void) | undefined;
			const f = fake(),
				h = yield* open(
					f,
					{ creds: CREDS },
					{
						emit: () =>
							new Promise<void>((r) => {
								land = r;
							})
					}
				);
			f.opened[0]!.ready();
			const pending = f.opened[0]!.deliver(raw('M1'));
			yield* until(() => land !== undefined);
			const closing = h.link.close ?? Effect.void;
			land!();
			yield* Effect.all([sdk(() => pending), closing], { concurrency: 'unbounded' });
			expect(f.opened[0]!.receipts).toEqual(['M1']);
		})
	);
	it.live(
		'a close stores what Baileys already acknowledged (a history chunk), past its grace and through a retry',
		() =>
			Effect.gen(function* () {
				let refusals = 1;
				const f = fake(),
					h = yield* open(
						f,
						{ creds: CREDS },
						{
							emit: async (e) => {
								if (e.kind === 'messages' && e.history === true && refusals-- > 0)
									throw new Error('busy');
							}
						}
					);
				const s = f.opened[0]!;
				s.ready();
				yield* until(() => h.status?.state === 'connected');
				s.ev.emit('messaging-history.set', { messages: [raw('H1'), raw('H2')] });
				yield* wait(10);
				yield* h.link.close ?? Effect.void;
				expect(
					messagesOf(h.events).map(
						(m) => Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(m).id
					)
				).toEqual(['H1', 'H2']);
			})
	);
	it.live('media too large to fetch is named, and the next message flows', () =>
		Effect.gen(function* () {
			const f = fake(),
				h = yield* open(f, { creds: CREDS });
			const s = f.opened[0]!;
			s.media = async (m) =>
				Schema.decodeUnknownSync(Schema.Struct({ key: Schema.Struct({ id: Schema.String }) }))(m)
					.key.id === 'BIG'
					? { name: 'site.mp4', mime: 'video/mp4', bytes: 40 * 1024 * 1024, data: null }
					: null;
			s.ready();
			yield* sdk(() =>
				s.deliver(raw('BIG', '', { message: { videoMessage: { mimetype: 'video/mp4' } } }))
			);
			yield* sdk(() => s.deliver(raw('NEXT', 'after')));
			expect(s.receipts).toEqual(['BIG', 'NEXT']);
			expect(h.events).toMatchObject([
				{
					kind: 'messages',
					messages: [
						{
							id: 'BIG',
							attachments: [{ name: 'site.mp4', mime: 'video/mp4', bytes: 40 * 1024 * 1024 }]
						}
					]
				},
				{ kind: 'messages', messages: [{ id: 'NEXT', text: 'after' }] }
			]);
			expect(h.events[0]).not.toHaveProperty('bins');
			yield* h.link.close ?? Effect.void;
		})
	);
	it.live('a history chunk is one event marked history; receipts become delivery reports', () =>
		Effect.gen(function* () {
			const f = fake(),
				h = yield* open(f, { creds: CREDS });
			const s = f.opened[0]!;
			s.ready();
			yield* until(() => h.status?.state === 'connected');
			s.ev.emit('messaging-history.set', { messages: [raw('H1'), raw('H2')] });
			s.ev.emit('messages.update', [{ key: { id: 'OUT1', fromMe: true }, update: { status: 3 } }]);
			s.ev.emit('message-receipt.update', [
				{ key: { id: 'OUT2', fromMe: true }, receipt: { readTimestamp: 1 } }
			]);
			yield* until(() => h.events.length === 3);
			expect(h.events).toEqual(
				expect.arrayContaining([
					{
						kind: 'messages',
						messages: [
							expect.objectContaining({ id: 'H1' }),
							expect.objectContaining({ id: 'H2' })
						],
						history: true
					},
					{
						kind: 'delivery',
						providerId: 'OUT1',
						report: expect.objectContaining({ kind: 'delivered' })
					},
					{
						kind: 'delivery',
						providerId: 'OUT2',
						report: expect.objectContaining({ kind: 'read' })
					}
				])
			);
			yield* h.link.close ?? Effect.void;
		})
	);
	it.live(
		'a personal account captures group membership and refreshes it after a participant change',
		() =>
			Effect.gen(function* () {
				const f = fake(),
					h = yield* open(f, { creds: CREDS }, { personal: true });
				const s = f.opened[0]!;
				expect(s.config.personal).toBe(true);
				let membership = [
					{ id: 'opaque@lid', phoneNumber: '6591009037@s.whatsapp.net', notify: 'POC' }
				];
				let reads = 0;
				s.socket.groupMetadata = async (jid) => {
					reads++;
					return { id: jid, owner: undefined, subject: 'Customer group', participants: membership };
				};
				const group = (id: string) => ({
					key: { id, remoteJid: '120363123@g.us', participant: '6599999999@s.whatsapp.net' },
					messageTimestamp: 1_790_000_000,
					message: { conversation: 'Discuss' }
				});
				s.ready();
				yield* until(() => h.status?.state === 'connected');
				yield* sdk(() => s.deliver(group('first')));
				membership = [];
				s.ev.emit('group-participants.update', { id: '120363123@g.us' });
				yield* sdk(() => s.deliver(group('second')));
				expect(reads).toBe(2);
				expect(messagesOf(h.events)).toMatchObject([
					{
						id: 'first',
						title: 'Customer group',
						participants: [{ handle: '6591009037@s.whatsapp.net', name: 'POC' }]
					},
					{ id: 'second', participants: [] }
				]);
				expect(yield* sdk(() => s.config.cachedGroupMetadata('120363123@g.us'))).toMatchObject({
					subject: 'Customer group'
				});
				membership = [
					{ id: 'updated@lid', phoneNumber: '6591009038@s.whatsapp.net', notify: 'Updated' }
				];
				s.ev.emit('groups.update', [{ id: '120363123@g.us' }]);
				expect(yield* sdk(() => s.config.cachedGroupMetadata('120363123@g.us'))).toMatchObject({
					participants: membership
				});
				expect(reads).toBe(3);
				yield* h.link.close ?? Effect.void;
			})
	);
	it.live(
		'a LID-only sender resolves to its phone through the account LID map, else stays a LID',
		() =>
			Effect.gen(function* () {
				const f = fake(),
					h = yield* open(f, { creds: CREDS }, { personal: true });
				const s = f.opened[0]!;
				const lookups: string[] = [];
				s.socket.signalRepository = {
					lidMapping: {
						getLIDForPN: async () => null,
						getPNForLID: async (lid) => {
							lookups.push(lid);
							return lid === 'known@lid' ? '6591009037:2@s.whatsapp.net' : null;
						}
					}
				};
				s.ready();
				yield* until(() => h.status?.state === 'connected');
				for (const jid of ['known@lid', 'unknown@lid'])
					yield* sdk(() => s.deliver(raw(jid, 'Voice?', { key: { id: jid, remoteJid: jid } })));
				expect(lookups).toEqual(['known@lid', 'unknown@lid']);
				expect(messagesOf(h.events)).toMatchObject([
					{
						id: 'known@lid',
						thread: '6591009037@s.whatsapp.net',
						from: { handle: '6591009037:2@s.whatsapp.net' }
					},
					{ id: 'unknown@lid', thread: 'unknown@lid', from: { handle: 'unknown@lid' } }
				]);
				yield* h.link.close ?? Effect.void;
			})
	);
});

describe('sending', () => {
	it.live(
		'sends only while connected; a retry receipt finds what was sent; attachments follow as their own messages',
		() =>
			Effect.gen(function* () {
				const f = fake(),
					h = yield* open(f, { creds: CREDS });
				const s = f.opened[0]!;
				expect(
					yield* Effect.flip(h.link.send!({ to: '659@s.whatsapp.net', text: 'x' }, undefined))
				).toMatchObject({ message: expect.stringMatching(/not open/) });
				s.ready();
				yield* until(() => h.status?.state === 'connected');
				expect(yield* h.link.send!({ to: '659@s.whatsapp.net', text: 'hello' }, undefined)).toEqual(
					{ providerId: 'OUT1' }
				);
				expect(yield* sdk(() => s.config.getMessage({ id: 'OUT1' }))).toEqual({
					conversation: 'sent 1'
				});
				// the account's own number (the test message) is a JID
				yield* h.link.send!({ to: '6580000000', text: 'test' }, undefined);
				expect(s.sent.at(-1)).toEqual({
					jid: '6580000000@s.whatsapp.net',
					content: { text: 'test' }
				});
				yield* h.link.send!({ to: '659@s.whatsapp.net', text: 'files' }, [
					file('report.pdf', 'application/pdf', '%PDF r'),
					file('chart.png', 'image/png', 'png')
				]);
				expect(s.sent.slice(-3)).toEqual([
					{ jid: '659@s.whatsapp.net', content: { text: 'files' } },
					{
						jid: '659@s.whatsapp.net',
						content: {
							document: Buffer.from('%PDF r'),
							mimetype: 'application/pdf',
							fileName: 'report.pdf'
						}
					},
					{
						jid: '659@s.whatsapp.net',
						content: { image: Buffer.from('png'), mimetype: 'image/png' }
					}
				]);
				// the sent messages outlive a reconnect
				s.drop(428);
				yield* f.socket(1);
				expect(yield* sdk(() => f.opened[1]!.config.getMessage({ id: 'OUT1' }))).toEqual({
					conversation: 'sent 1'
				});
				yield* h.link.close ?? Effect.void;
			})
	);
	it.live('unpair logs the device out and waits for its key writes', () =>
		Effect.gen(function* () {
			let logouts = 0;
			const f = fake(),
				h = yield* open(f, { creds: CREDS });
			f.opened[0]!.socket.logout = async () => {
				logouts++;
			};
			f.opened[0]!.ready();
			yield* h.link.unpair!();
			expect(logouts).toBe(1);
			expect(f.opened[0]!.ended).toBe(true);
			yield* h.link.close ?? Effect.void;
		})
	);
});
