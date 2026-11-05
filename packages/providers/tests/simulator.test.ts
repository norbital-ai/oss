// The real WhatsApp and Telegram providers against the running channel simulator: only the far end is pretend, so
// pairing, a raw inbound message's parsing and the provider's send all run as they do in production.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { simulatedProviders, startSimulator } from '../src/simulator/index.ts';
import { hookServer, host, until, type Host } from './kit.ts';

const simulator = Effect.acquireRelease(
	Effect.promise(() => startSimulator()),
	(running) => Effect.promise(running.close)
);
const provider = (url: string, id: string) => {
	const found = simulatedProviders(url).find((one) => one.id === id);
	if (found === undefined) throw new Error(`no ${id}`);
	return found;
};
const inbound = (url: string, body: object) =>
	Effect.promise(() =>
		fetch(`${url}/inbound`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	);
const connected = (h: Host) => until(() => h.status?.state === 'connected');
const accountOf = (h: Host) => Schema.decodeUnknownSync(Schema.Struct({ account: Schema.String }))(h.status);

describe('the channel simulator', () => {
	it.live('WhatsApp pairs with no phone, hears a customer and answers through the real provider', () =>
		Effect.gen(function* () {
			const running = yield* simulator,
				h = yield* host(provider(running.url, 'simulated-whatsapp'), fetch);
			yield* h.link.pair!({});
			yield* connected(h);
			expect(h.values.size).toBeGreaterThan(0);
			const account = accountOf(h).account;
			expect(
				(yield* inbound(running.url, { account: 'nobody', from: '65', text: 'hi' })).status
			).toBe(409);
			expect(
				(yield* inbound(running.url, {
					channel: 'whatsapp',
					account,
					from: '+65 9123 4567',
					name: 'Ana',
					text: 'Is my order ready?'
				})).status
			).toBe(200);
			yield* until(() => h.events.length > 0);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						text: 'Is my order ready?',
						thread: '6591234567@s.whatsapp.net',
						from: { handle: '6591234567@s.whatsapp.net', name: 'Ana' },
						group: false
					}
				]
			});
			yield* h.link.send!(
				{ id: 'm1', to: '6591234567@s.whatsapp.net', text: 'Yes, it ships today' },
				[]
			);
			expect(running.messages().at(-1)).toMatchObject({
				channel: 'whatsapp',
				direction: 'out',
				peer: '6591234567',
				text: 'Yes, it ships today'
			});
		})
	);
	it.live('Telegram pairs, takes an update on its real webhook and answers', () =>
		Effect.gen(function* () {
			const running = yield* simulator;
			const hook = yield* hookServer,
				h = yield* host(provider(running.url, 'simulated-telegram'), fetch, undefined, {
					webhookUrl: hook.url
				}),
				run = yield* Effect.context<never>();
			hook.route.to = (request) => Effect.runPromiseWith(run)(h.link.webhook!(request));
			yield* h.link.pair!({ token: '123456:simulated' });
			expect(accountOf(h).account).toBe('@simulated_123456_bot');
			expect(
				(yield* inbound(running.url, {
					channel: 'telegram',
					account: '123456',
					from: '555',
					name: 'Ana',
					text: 'Hello bot'
				})).status
			).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [{ text: 'Hello bot', from: { handle: '555', name: 'Ana' }, group: false }]
			});
			yield* h.link.send!({ id: 'm1', to: '555', text: 'Hello Ana' }, []);
			expect(running.messages().at(-1)).toMatchObject({
				channel: 'telegram',
				direction: 'out',
				peer: '555',
				text: 'Hello Ana'
			});
		})
	);
	it.live('a dropped delivery and a delete with no event show only in the platform’s history', () =>
		Effect.gen(function* () {
			const running = yield* simulator;
			const hook = yield* hookServer,
				h = yield* host(provider(running.url, 'simulated-chat'), fetch, undefined, {
					webhookUrl: hook.url
				}),
				run = yield* Effect.context<never>();
			hook.route.to = (request) => Effect.runPromiseWith(run)(h.link.webhook!(request));
			yield* h.link.pair!({});
			const account = accountOf(h).account,
				sent = (body: object) =>
					inbound(running.url, { channel: 'chat', account, from: '555', ...body }).pipe(
						Effect.flatMap((response) =>
							Effect.promise(() => response.json() as Promise<{ id: string }>)
						)
					);
			const kept = yield* sent({ text: 'stays' }),
				gone = yield* sent({ text: 'goes' });
			yield* sent({ text: 'lost on the way', drop: true });
			expect(h.events).toHaveLength(2);
			yield* Effect.promise(() =>
				fetch(`${running.url}/chat/delete`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ account, id: gone.id })
				})
			);
			expect(h.events).toHaveLength(2);
			const page = yield* h.link.reconcile!('555', '2020-01-01T00:00:00.000Z');
			expect(page.complete).toBe(true);
			expect(page.messages).toHaveLength(2);
			expect(page.messages[0]).toMatchObject({ id: kept.id, text: 'stays' });
			expect(page.messages[1]).toMatchObject({ text: 'lost on the way' });
			yield* h.link.send!({ to: '555', text: 'Answered' }, []);
			expect(running.messages().at(-1)).toMatchObject({ direction: 'out', text: 'Answered' });
		})
	);
});
