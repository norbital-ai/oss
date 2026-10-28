// The WhatsApp Web link under bolt's own links manager and engine (PGlite), over the fake socket: the keys round-trip
// through the sealed instance credentials, a message stored but never receipted (the process died between) is one row
// after WhatsApp redelivers it, media past what a row stores is a named descriptor and the next message still flows, and
// a second host opening the instance fences the first for good.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { engineHost } from './engine-host.ts';
import { EngineManifestSchema } from '@norbital-ai/bolt/engine';
import { fake, raw } from './baileys-fake.ts';
import { until } from './kit.ts';
/** A message's files: its conversation's inputs that name it (Bolt keeps no files column on the message). */
const FILES = `(SELECT coalesce(jsonb_agg(f.e - 'message' ORDER BY f.at), '[]'::jsonb) FROM sys_conversation fc,
	jsonb_array_elements(fc.inputs) WITH ORDINALITY AS f(e, at) WHERE fc.id = m.conversation AND f.e->>'message' = m.id)`;

class SdkRejected extends Schema.TaggedError<SdkRejected>()('SdkRejected', {
	cause: Schema.Defect()
}) {}
const sdk = <A>(call: () => Promise<A>) =>
	Effect.tryPromise({ try: call, catch: (cause) => new SdkRejected({ cause }) });

const manifest = Schema.decodeUnknownSync(EngineManifestSchema)({
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	pipelines: {},
	integrations: {},
	connections: { wa: { integration: 'whatsapp' } },
	policies: {},
	teams: {},
	automations: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
});

// a PGlite engine host per test: bolt's integration budget, not the 5 s unit default
describe('the WhatsApp Web link on a host', { timeout: 15_000 }, () => {
	it.live(
		'keys round-trip through the sealed credentials; a message stored but not receipted is one row after its redelivery',
		() =>
			engineHost({ manifest }, ({ t, store, links }) =>
				Effect.gen(function* () {
					const rows = (id: string) =>
						t.db.rows(Schema.Struct({ provider_id: Schema.String, files: Schema.Json }), {
							text: `SELECT provider_id, ${FILES} AS files FROM sys_message m WHERE integration = 'wa' AND provider_id = $1`,
							params: [id]
						});
					const first = fake(),
						one = yield* links([first.provider]);
					yield* one.pair('wa', {});
					yield* first.socket(0);
					const s = first.opened[0]!;
					yield* sdk(() => s.paired());
					yield* sdk(() => s.config.store.set({ session: { '659.0': { record: 'r1' } } }));
					s.ready();
					// stored, then the process dies before the receipt leaves
					yield* sdk(() => s.config.beforeReceipt(raw('M1', 'hello'), 'notify'));
					expect(yield* rows('M1')).toHaveLength(1);
					const second = fake(),
						two = yield* links([second.provider]);
					yield* two.resume;
					yield* second.socket(0);
					const r = second.opened[0]!;
					expect(r.config.store.creds).toMatchObject({ account: { details: 'signed' } });
					expect(r.config.store.get('session', ['659.0'])).toEqual({ '659.0': { record: 'r1' } });
					r.ready();
					yield* sdk(() => r.deliver(raw('M1', 'hello'))); // WhatsApp redelivers what it never got a receipt for
					expect(r.receipts).toEqual(['M1']);
					expect(yield* rows('M1')).toHaveLength(1);
					yield* two.close;
					yield* one.close;
				})
			)
	);
	it.live('media past what a row stores is a named descriptor, and the next message flows', () =>
		engineHost({ manifest }, ({ t, store, links }) =>
			Effect.gen(function* () {
				const rows = (id: string) =>
					t.db.rows(Schema.Struct({ provider_id: Schema.String, files: Schema.Json }), {
						text: `SELECT provider_id, ${FILES} AS files FROM sys_message m WHERE integration = 'wa' AND provider_id = $1`,
						params: [id]
					});
				const f = fake(),
					host = yield* links([f.provider]);
				yield* host.pair('wa', {});
				yield* f.socket(0);
				const s = f.opened[0]!;
				yield* sdk(() => s.paired());
				const big = new Uint8Array(25 * 1024 * 1024);
				s.media = async (m) =>
					Schema.decodeUnknownSync(Schema.Struct({ key: Schema.Struct({ id: Schema.String }) }))(m)
						.key.id === 'BIG'
						? { name: 'site.mp4', mime: 'video/mp4', bytes: big.byteLength, data: big }
						: null;
				s.ready();
				yield* sdk(() =>
					s.deliver(
						raw('BIG', 'the site', {
							message: { videoMessage: { caption: 'the site', mimetype: 'video/mp4' } }
						})
					)
				);
				yield* sdk(() => s.deliver(raw('NEXT', 'and then')));
				expect(s.receipts).toEqual(['BIG', 'NEXT']);
				expect(yield* rows('BIG')).toEqual([
					{
						provider_id: 'BIG',
						files: [{ name: 'site.mp4', mime: 'video/mp4', bytes: big.byteLength }]
					}
				]);
				expect(yield* rows('NEXT')).toHaveLength(1);
				yield* host.close;
			})
		)
	);
	it.live(
		'typing reads the waiting messages and goes online once; off sends paused; a DM sender is watched for typing',
		() =>
			engineHost({ manifest }, ({ links }) =>
				Effect.gen(function* () {
					const f = fake(),
						host = yield* links([f.provider]);
					yield* host.pair('wa', {});
					yield* f.socket(0);
					const s = f.opened[0]!;
					yield* sdk(() => s.paired());
					s.ready();
					yield* sdk(() => s.deliver(raw('T1', 'are you there')));
					const jid = '659@s.whatsapp.net';
					expect(s.subscribed).toEqual([jid]);
					// `ready` is processed after this step: typing does nothing until the link is connected
					const typed = host.port
						.typing('wa', jid, true)
						.pipe(Effect.andThen(Effect.sync(() => s.read.length > 0)));
					while (!(yield* typed)) yield* Effect.sleep('10 millis');
					expect(s.read).toEqual([{ remoteJid: jid, id: 'T1' }]);
					expect(s.presence).toEqual([
						['available', undefined],
						['composing', jid]
					]);
					yield* host.port.typing('wa', jid, false);
					yield* host.port.typing('wa', jid, true); // nothing new to read, already online
					expect(s.read).toHaveLength(1);
					expect(s.presence.slice(2)).toEqual([
						['paused', jid],
						['composing', jid]
					]);
					yield* sdk(() => s.deliver(raw('T2', 'hello again')));
					expect(s.subscribed).toEqual([jid]); // watched once per socket
					yield* host.close;
				})
			)
	);
	it.live(
		'a second host opening the instance fences the first: its next key write stops it for good',
		() =>
			engineHost({ manifest }, ({ t, store, links }) =>
				Effect.gen(function* () {
					const rows = (id: string) =>
						t.db.rows(Schema.Struct({ provider_id: Schema.String, files: Schema.Json }), {
							text: `SELECT provider_id, ${FILES} AS files FROM sys_message m WHERE integration = 'wa' AND provider_id = $1`,
							params: [id]
						});
					const first = fake(),
						one = yield* links([first.provider]);
					yield* one.pair('wa', {});
					yield* first.socket(0);
					yield* sdk(() => first.opened[0]!.paired());
					first.opened[0]!.ready();
					const second = fake(),
						two = yield* links([second.provider]);
					yield* two.resume;
					yield* second.socket(0);
					expect(
						yield* Effect.flip(
							sdk(() => first.opened[0]!.config.store.set({ session: { a: { record: 'stale' } } }))
						)
					).toMatchObject({
						_tag: 'SdkRejected',
						cause: expect.objectContaining({ _tag: 'LinkClosed' })
					});
					yield* until(() => first.opened[0]!.ended);
					expect(yield* one.state('wa')).toMatchObject({ state: 'error', code: 'replaced' });
					first.opened[0]!.drop(428);
					yield* Effect.sleep('20 millis');
					expect(first.opened).toHaveLength(1);
					// the second host's writes land
					yield* sdk(() =>
						second.opened[0]!.config.store.set({ session: { a: { record: 'fresh' } } })
					);
					expect((yield* store.read('wa')).values.get('session:a')).toEqual({ record: 'fresh' });
					yield* one.close;
					yield* two.close;
				})
			)
	);
});
