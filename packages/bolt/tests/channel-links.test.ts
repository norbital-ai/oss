// engine/channels/links.ts: the host half every host shares — one link per channel from the provider the operator
// chose, sealed credentials resumed at boot, several channels on one transport, per-channel webhooks and the admin answers.
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import {
	connection,
	decodeConnection,
	localText,
	type ChannelOpen,
	type ChannelProvider
} from '../src/engine/channels/connection.ts';
import { channelLinks } from '../src/engine/channels/links.ts';
import type { Authority, EngineManifest, TransportEvent } from '../src/engine/contracts.ts';

/** A provider that pairs on `{ key }` and refuses anything else; it records what it opened with. */
const fake = (id: string, opened: ChannelOpen[] = []): ChannelProvider => ({
	transport: 'whatsapp',
	supportsSync: true,
	id,
	label: `Fake ${id}`,
	setup: {
		kind: 'form',
		steps: [{ text: 'Paste the key' }],
		fields: [{ name: 'key', label: 'Key', secret: true }],
		webhook: true
	},
	async open(ctx) {
		opened.push(ctx);
		let as = ctx.credential === null ? null : String((ctx.credential as { key: string }).key);
		return {
			async send(channel, message) {
				return { providerId: `${id}:${channel}:${(message as { text: string }).text}` };
			},
			connection: () =>
				connection(ctx.channel, 'whatsapp', as === null ? 'unpaired' : 'connected', {
					pairedAs: as,
					stored: as !== null
				}),
			async pair(input) {
				const key = (input as { key?: unknown }).key;
				if (typeof key !== 'string') throw new Error('a key is required');
				await ctx.save({ key });
				as = key;
				ctx.changed();
			},
			async unpair() {
				await ctx.save(null);
				as = null;
			},
			async webhook(req) {
				await ctx.emit({
					kind: 'inbound',
					channel: 'ignored',
					message: (await req.json()) as Json
				});
				return new Response('ok');
			},
			async close() {}
		};
	}
});

const manifest = {
	channels: {
		a: { transport: 'whatsapp' },
		b: { transport: 'whatsapp' },
		own: { transport: 'custom', send: 'api' },
		tg: { transport: 'telegram' }
	}
} as unknown as EngineManifest;
const host = (sealed: Map<string, Json>, providers: ChannelProvider[]) =>
	channelLinks({
		manifest,
		providers,
		load: async (c) => sealed.get(c) ?? null,
		store: async (c, v) => {
			if (v === null) sealed.delete(c);
			else sealed.set(c, v);
		},
		webhookUrl: (c, t) => `https://ws.example/hooks/bolt.${t}/${c}`,
		log: () => {}
	});
const post = (body: Json) =>
	new Request('https://ws.example/x', { method: 'POST', body: JSON.stringify(body) });

describe('channel links', () => {
	it('a transport with two providers asks which; each channel pairs, seals and sends on its own', async () => {
		const sealed = new Map<string, Json>();
		const links = host(sealed, [fake('twilio'), fake('baileys')]);
		await expect(links.pair('a', { key: 'k1' })).rejects.toThrow(
			/choose how to connect.*twilio, baileys/
		);
		await links.pair('a', { provider: 'twilio', key: 'k1' });
		await links.pair('b', { provider: 'baileys', key: 'k2' });
		expect(sealed.get('a')).toEqual({ provider: 'twilio', credential: { key: 'k1' } });
		expect(links.state('a')).toMatchObject({
			state: 'connected',
			provider: 'twilio',
			pairedAs: 'k1',
			about: { webhookUrl: 'https://ws.example/hooks/bolt.whatsapp/a' }
		});
		expect(links.state('a').providers?.map((p) => p.id)).toEqual(['twilio', 'baileys']);
		const port = links.transports.whatsapp!;
		expect(await port.send('a', { text: 'x' }, AbortSignal.timeout(1000))).toEqual({
			providerId: 'twilio:a:x'
		});
		expect(await port.send('b', { text: 'y' }, AbortSignal.timeout(1000))).toEqual({
			providerId: 'baileys:b:y'
		});
		await expect(port.send('tg', { text: 'z' }, AbortSignal.timeout(1000))).rejects.toThrow(
			/not connected/
		);
	});

	it('a refused pairing keeps nothing; unpair destroys the sealed credential', async () => {
		const sealed = new Map<string, Json>();
		const links = host(sealed, [fake('twilio')]);
		await expect(links.pair('a', {})).rejects.toThrow(/key is required/);
		expect(links.state('a').state).toBe('unpaired');
		await links.pair('a', { key: 'k' });
		await links.unpair('a');
		expect(sealed.has('a')).toBe(false);
		expect(links.state('a').state).toBe('unpaired');
	});

	it('resumes what was sealed, per provider; the webhook routes by channel and events carry the channel', async () => {
		const sealed = new Map<string, Json>([
			['b', { provider: 'baileys', credential: { key: 'k2' } }],
			['a', { provider: 'gone', credential: {} }]
		]);
		const opened: ChannelOpen[] = [];
		const links = host(sealed, [fake('twilio', opened), fake('baileys', opened)]);
		await links.resume();
		expect(opened.map((o) => [o.channel, o.credential])).toEqual([['b', { key: 'k2' }]]);
		const seen: TransportEvent[] = [];
		links.transports.whatsapp!.subscribe(async (e) => {
			seen.push(e);
		});
		expect((await links.webhook('b', post({ id: '1' }))).status).toBe(200);
		expect((await links.webhook('a', post({ id: '2' }))).status).toBe(404);
		expect(seen).toEqual([{ kind: 'inbound', channel: 'b', message: { id: '1' } }]);
	});

	it('answers the admin routes with the one ChannelConnection; a transport with no provider is Unavailable', async () => {
		const links = host(new Map(), [fake('twilio')]);
		const get = await links.admin(new Request('https://ws.example/x'), 'a', '');
		expect(
			decodeConnection('a', ((await get.json()) as { value: Json }).value)?.providers?.[0]?.setup
				.fields
		).toEqual([{ name: 'key', label: 'Key', secret: true }]);
		expect((await links.admin(post({ key: 'k' }), 'a', 'pair')).status).toBe(200);
		expect(await (await links.admin(post({}), 'b', 'pair')).json()).toEqual({
			error: { code: 'invalid', message: 'a key is required' }
		});
		expect((await links.admin(new Request('https://ws.example/x'), 'tg', '')).status).toBe(503);
		expect((await links.admin(new Request('https://ws.example/x'), 'nope', '')).status).toBe(404);
		const stream = await links.admin(
			new Request('https://ws.example/x', { headers: { accept: 'text/event-stream' } }),
			'a',
			''
		);
		const first = await stream.body!.getReader().read();
		expect(new TextDecoder().decode(first.value)).toMatch(/^data: .*"state":"connected"/);
	});

	it('a custom channel records what its own connect page sends', async () => {
		const sealed = new Map<string, Json>();
		const links = host(sealed, []);
		expect(links.state('own').state).toBe('unpaired');
		await links.pair('own', { account: 'acme' });
		expect(sealed.get('own')).toEqual({ provider: 'workspace', credential: { account: 'acme' } });
		expect(links.state('own')).toMatchObject({ state: 'connected', providers: [] });
	});
});

describe('a provider that signs in with OAuth and tests itself (the email mailbox)', () => {
	const tested: string[] = [];
	const mailbox: ChannelProvider = {
		transport: 'email',
		id: 'microsoft',
		label: 'Microsoft 365',
		test: {},
		setup: {
			kind: 'form',
			steps: [{ text: 'Register this redirect URI', copy: 'redirectUrl' }],
			fields: [
				{
					name: 'tracking',
					label: 'Open tracking',
					optional: true,
					options: [
						{ value: 'off', label: 'Off' },
						{ value: 'on', label: { en: 'On', zh: '开启' } }
					]
				}
			]
		},
		async open(ctx) {
			let signedIn = false,
				pending = false;
			return {
				async send() {
					return { providerId: '<x@acme.example>' };
				},
				connection: () =>
					pending
						? connection(ctx.channel, 'email', 'pairing', {
								pairing: {
									kind: 'oauth',
									value: 'https://login.example/authorize?state=s',
									label: 'Sign in with Microsoft'
								}
							})
						: connection(ctx.channel, 'email', signedIn ? 'connected' : 'unpaired', {
								stored: signedIn
							}),
				async pair() {
					pending = true;
					ctx.changed();
				},
				async unpair() {},
				async webhook(req) {
					signedIn = new URL(req.url).pathname.endsWith('/oauth/callback');
					pending = false;
					ctx.changed();
					return new Response('ok');
				},
				async test() {
					tested.push(ctx.channel);
				},
				async close() {}
			};
		}
	};
	const links = () =>
		channelLinks({
			manifest: { channels: { mail: { transport: 'email' } } } as unknown as EngineManifest,
			providers: [mailbox],
			load: async () => null,
			store: async () => {},
			webhookUrl: (c) => `https://ws.example/hooks/bolt.email/${c}`,
			log: () => {}
		});
	it("shows the redirect URI under the channel's webhook, publishes the authorize URL, and the callback reaches the link", async () => {
		const l = links();
		expect(l.state('mail').about).toEqual({
			redirectUrl: 'https://ws.example/hooks/bolt.email/mail/oauth/callback'
		});
		await l.pair('mail', {});
		const wire = decodeConnection('mail', JSON.parse(JSON.stringify(l.state('mail'))) as Json)!;
		expect(wire.pairing).toEqual({
			kind: 'oauth',
			value: 'https://login.example/authorize?state=s',
			label: 'Sign in with Microsoft'
		});
		expect(wire.providers![0]!.setup.steps[0]!.copy).toBe('redirectUrl');
		expect(wire.providers![0]!.setup.fields![0]!.options).toEqual([
			{ value: 'off', label: 'Off' },
			{ value: 'on', label: { en: 'On', zh: '开启' } }
		]);
		expect(
			(
				await l.webhook(
					'mail',
					new Request('https://ws.example/hooks/bolt.email/mail/oauth/callback?code=c&state=s')
				)
			).status
		).toBe(200);
		expect(l.state('mail').state).toBe('connected');
	});
	it("a test runs the provider's own round trip", async () => {
		const l = links();
		await l.pair('mail', {});
		await l.webhook('mail', new Request('https://ws.example/hooks/bolt.email/mail/oauth/callback'));
		expect((await l.admin(post({}), 'mail', 'test')).status).toBe(200);
		expect(tested).toEqual(['mail']);
	});
});

describe('a test send and provider text by locale', () => {
	const sent: Json[] = [];
	const testing = (to: boolean): ChannelProvider => {
		const base = fake(to ? 'twilio' : 'baileys');
		return {
			...base,
			test: to ? { to: { name: 'to', label: { en: 'Send to', zh: '发送至' } } } : {},
			async open(ctx) {
				const l = await base.open(ctx);
				return {
					...l,
					async send(_c, m) {
						sent.push(m);
						return { providerId: 't1' };
					}
				};
			}
		};
	};
	it('is offered only once connected; goes to the typed handle, or to the connected account itself', async () => {
		sent.length = 0;
		const links = host(new Map(), [testing(true), testing(false)]);
		expect(links.state('a').test).toBeUndefined();
		expect((await links.admin(post({ to: 'x' }), 'a', 'test')).status).toBe(400);
		await links.pair('a', { provider: 'twilio', key: 'k1' });
		await links.pair('b', { provider: 'baileys', key: 'me@s.whatsapp.net' });
		expect(links.state('a').test).toEqual({
			to: { name: 'to', label: { en: 'Send to', zh: '发送至' } }
		});
		expect(await (await links.admin(post({}), 'a', 'test')).json()).toEqual({
			error: { code: 'invalid', message: 'name where the test message goes' }
		});
		expect((await links.admin(post({ to: 'whatsapp:+6591111111' }), 'a', 'test')).status).toBe(200);
		expect((await links.admin(post({}), 'b', 'test')).status).toBe(200);
		expect(sent).toMatchObject([
			{ to: 'whatsapp:+6591111111', text: expect.stringContaining('Norbital test message') },
			{ to: 'me@s.whatsapp.net' }
		]);
	});
	it('decodes localized setup text and picks it by locale, English when a locale has none', () => {
		const c = decodeConnection('a', {
			state: 'unpaired',
			providers: [
				{
					id: 'p',
					label: { en: 'Official', zh: '官方' },
					setup: {
						kind: 'form',
						steps: [{ text: { en: 'Paste it' } }, { text: 7 }],
						fields: [{ name: 'k', label: { en: 'Key', zh: '密钥' }, hint: 'plain' }]
					}
				}
			],
			test: { to: { name: 'to', label: 'To' } }
		})!;
		const p = c.providers![0]!;
		expect(localText(p.label, 'zh-CN')).toBe('官方');
		expect(localText(p.setup.steps[0]!.text, 'zh')).toBe('Paste it');
		expect(p.setup.steps).toHaveLength(1);
		expect(localText(p.setup.fields![0]!.label, 'en')).toBe('Key');
		expect(c.test).toEqual({ to: { name: 'to', label: 'To' } });
	});
});

describe('personal channel accounts', () => {
	it('seals, resumes and routes accounts independently to the declared integration channel', async () => {
		const sealed = new Map<string, Json>(),
			seen: TransportEvent[] = [];
		const make = () =>
			channelLinks({
				manifest: {
					channels: { personal: { transport: 'whatsapp', accounts: true, syncOnly: true } }
				},
				providers: [fake('baileys')],
				load: async (key) => sealed.get(key) ?? null,
				store: async (key, value) => {
					if (value === null) sealed.delete(key);
					else sealed.set(key, value);
				},
				webhookUrl: (channel) => `https://ws.example/hooks/bolt.whatsapp/${channel}`,
				emit: async (_transport, event) => {
					seen.push(event);
				}
			});
		const links = make();
		for (const id of ['alice', 'bob']) {
			expect((await links.admin(post({ id }), 'personal', 'accounts')).status).toBe(200);
			await links.pair(`personal~${id}`, { key: id });
		}
		expect((await links.admin(post({ id: '../bad' }), 'personal', 'accounts')).status).toBe(400);
		await expect(links.pair('personal~missing', { key: 'missing' })).rejects.toThrow(/no channel/);
		await links.webhook('personal~alice', post({ id: 'same', thread: 'customer', text: 'Hi' }));
		await links.webhook('personal~bob', post({ id: 'same', thread: 'customer', text: 'Hi' }));
		expect(seen).toEqual(
			['alice', 'bob'].map((id) => ({
				kind: 'inbound',
				channel: 'personal',
				message: {
					id: `${id}:same`,
					thread: `${id}:customer`,
					text: 'Hi',
					sourceAccount: id
				}
			}))
		);
		await links.close();
		const resumed = make();
		await resumed.resume();
		expect(resumed.state('personal~alice')).toMatchObject({
			state: 'connected',
			pairedAs: 'alice'
		});
		await resumed.unpair('personal~alice');
		expect(resumed.state('personal~bob')).toMatchObject({ state: 'connected', pairedAs: 'bob' });
		expect(sealed.has('personal~alice')).toBe(false);
		await resumed.close();
	});
});

describe('personal channel account authorization', () => {
	const member = (id: string, admin = false, external = false): Authority => ({
		key: id,
		actor: {
			kind: 'member',
			id,
			email: null,
			phone: null,
			external,
			admin,
			teams: [],
			teamPath: [],
			party: null
		},
		admin,
		policies: [],
		collections: {},
		automations: [],
		capabilities: { apps: [], tools: [], mcp: [], skills: [] },
		limits: [],
		teamTree: [],
		scopes: {}
	});
	it('persists ownership, filters accounts, and refuses other owners and external members', async () => {
		const sealed = new Map<string, Json>();
		const make = () =>
			channelLinks({
				manifest: {
					channels: {
						personal: { transport: 'whatsapp', accounts: true, syncOnly: true },
						shared: { transport: 'whatsapp', accounts: true }
					}
				},
				providers: [fake('fake')],
				load: async (key) => sealed.get(key) ?? null,
				store: async (key, value) => {
					if (value === null) sealed.delete(key);
					else sealed.set(key, value);
				},
				webhookUrl: () => 'https://ws.example/hook'
			});
		const links = make();
		await links.resume();
		expect(
			(await links.admin(post({ id: 'phone' }), 'personal', 'accounts', member('alice'))).status
		).toBe(200);
		expect(
			(await links.admin(post({ id: 'phone' }), 'personal', 'accounts', member('bob'))).status
		).toBe(403);
		expect(
			(
				await links.admin(
					post({ id: 'phone2' }),
					'personal',
					'accounts',
					member('alice', false, true)
				)
			).status
		).toBe(403);
		expect(
			(await links.admin(post({ id: 'shared' }), 'shared', 'accounts', member('alice'))).status
		).toBe(403);
		const resumed = make();
		await resumed.resume();
		const get = () => new Request('https://ws.example/x');
		expect(
			await (await resumed.admin(get(), 'personal', 'accounts', member('bob'))).json()
		).toEqual({ value: [] });
		expect((await resumed.admin(get(), 'personal~phone', '', member('bob'))).status).toBe(403);
		expect((await resumed.admin(get(), 'personal~phone', '', member('alice'))).status).toBe(200);
		expect((await resumed.admin(get(), 'personal~phone', '', member('admin', true))).status).toBe(
			200
		);
		expect((await resumed.admin(post({}), 'personal~phone', 'test', member('alice'))).status).toBe(
			400
		);
	});
});
