// Every host's channel links (rule 61): one live `ChannelLink` per declared channel, opened from the provider the
// operator chose at setup and the credential the host sealed. A host registers its providers (`@norbital-ai/providers`)
// and its sealed store; this file owns the rest — the per-transport ports the engine sends through (dispatching by
// channel, so several channels share a transport), resume at boot, pair/unpair, the channel's webhook, and the
// administrators' `/__bolt/transports/<channel>` answers. Nothing here names a provider (P18).
import type { Json } from '../../decl/values.ts';
import type {
	Authority,
	EngineManifest,
	TransportEvent,
	TransportPort,
	Transports
} from '../contracts.ts';
import {
	connection,
	OAUTH_CALLBACK,
	type ChannelConnection,
	type ChannelLink,
	type ChannelProvider,
	type ProviderChoice
} from './connection.ts';
import { verifySignature } from '../runs/webhook.ts';
import { isReported } from './status.ts';
import { isObj } from './store.ts';

export type LinkHost = {
	manifest: Pick<EngineManifest, 'channels'>;
	providers: readonly ChannelProvider[];
	/** The channel's sealed `{ provider, credential }`, or `null`. */
	load(channel: string): Promise<Json | null>;
	/** Seals it (`null` destroys it). */
	store(channel: string, sealed: Json | null): Promise<void>;
	/** The channel's own inbound URL on this host. */
	webhookUrl(channel: string, transport: string): string;
	/** Where inbound goes; default the transport ports' subscribers (a host that wakes a scaled-down engine routes it itself). */
	emit?(transport: string, event: TransportEvent): Promise<void>;
	fetch?: typeof fetch;
	log?(line: string): void;
};

/**
 * A custom channel is set up by the workspace's own `+<name>.connect.svelte`: what that page pairs with is sealed as the
 * credential. A channel declaring `inbound` gets its webhook: the declared `verify.scheme` is checked with the credential's
 * `verify.secret` field over the raw body before anything is read, then the verified `{ body, headers }` goes to the
 * engine, where the channel's own `inbound.messages` maps it (the workspace's code never sees an unverified request).
 */
const workspaceProvider = (m: LinkHost['manifest']): ChannelProvider => ({
	transport: 'custom',
	supportsSync: true,
	id: 'workspace',
	label: { en: 'Workspace', zh: '工作区' },
	setup: { kind: 'none', steps: [] },
	async open(ctx) {
		let credential = ctx.credential;
		const inbound = m.channels[ctx.channel.split('~')[0]!]?.['inbound'];
		const verify = isObj(inbound) && isObj(inbound['verify']) ? inbound['verify'] : null;
		return {
			send: async () => {
				throw new Error('a custom channel sends through its connection');
			},
			connection: () =>
				connection(ctx.channel, 'custom', credential !== null ? 'connected' : 'unpaired', {
					stored: credential !== null
				}),
			async pair(input) {
				await ctx.save(input);
				credential = input;
				ctx.changed();
			},
			async unpair() {
				await ctx.save(null);
				credential = null;
				ctx.changed();
			},
			async close() {},
			...(verify === null
				? {}
				: {
						async webhook(request: Request) {
							const secret = isObj(credential) ? credential[String(verify['secret'])] : undefined;
							const body = new Uint8Array(await request.arrayBuffer()),
								headers = Object.fromEntries(request.headers);
							if (
								typeof secret !== 'string' ||
								secret === '' ||
								!verifySignature(
									String(verify['scheme']),
									secret,
									{ method: request.method, headers, body },
									Date.now()
								)
							)
								return new Response(null, { status: 401 });
							let json: Json;
							try {
								json = JSON.parse(new TextDecoder().decode(body)) as Json;
							} catch {
								return new Response(null, { status: 400 });
							}
							await ctx.emit({
								kind: 'inbound',
								channel: ctx.channel,
								message: { body: json, headers }
							});
							return new Response(null, { status: 200 });
						}
					})
		};
	}
});

const refuse = (status: number, code: string, message: string) =>
	Response.json({ error: { code, message } }, { status });
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function channelLinks(h: LinkHost) {
	const log = h.log ?? ((line: string) => console.log(`[bolt] ${line}`));
	const live = new Map<string, { provider: ChannelProvider; link: ChannelLink }>();
	const watchers = new Map<string, Set<(c: ChannelConnection) => void>>();
	const sinks = new Map<string, Set<(e: TransportEvent) => Promise<void>>>();
	const baseOf = (channel: string) => channel.split('~')[0]!;
	const accounts = new Map<string, Set<string>>();
	const owners = new Map<string, Record<string, string>>();
	// ponytail: account registration serializes in this host; use a tenant lease before adding replicas.
	let registration = Promise.resolve();
	const transportOf = (channel: string): string | undefined => {
		const base = baseOf(channel);
		if (
			base !== channel &&
			(h.manifest.channels[base]?.['accounts'] !== true ||
				!accounts.get(base)?.has(channel.slice(base.length + 1)))
		)
			return undefined;
		const t = h.manifest.channels[base]?.['transport'];
		return typeof t === 'string' ? t : undefined;
	};
	const WORKSPACE = workspaceProvider(h.manifest);
	const choices = (transport: string, channel: string): readonly ChannelProvider[] =>
		[...h.providers, WORKSPACE].filter(
			(p) =>
				p.transport === transport &&
				(h.manifest.channels[baseOf(channel)]?.['syncOnly'] !== true ||
					(p.supportsSync === true &&
						(p !== WORKSPACE ||
							isObj(h.manifest.channels[baseOf(channel)]?.['inbound']) ||
							isObj(h.manifest.channels[baseOf(channel)]?.['poll']))))
		);
	const emit = async (transport: string, event: TransportEvent) => {
		if (h.emit !== undefined) return h.emit(transport, event);
		for (const s of sinks.get(transport) ?? []) await s(event);
	};

	/** The one `ChannelConnection` the shell reads: the link's own state plus the choices and this channel's webhook URL. */
	function state(channel: string): ChannelConnection {
		const transport = transportOf(channel) ?? '';
		const held = live.get(channel),
			ps = choices(transport, channel);
		const base = held?.link.connection() ?? connection(channel, transport, 'unpaired');
		const descriptions = ps.map((p): ProviderChoice => ({
			id: p.id,
			...(p.name === undefined ? {} : { name: p.name }),
			...(p.description === undefined ? {} : { description: p.description }),
			...(p.icon === undefined ? {} : { icon: p.icon }),
			...(p.describe?.({
				syncOnly: h.manifest.channels[baseOf(channel)]?.['syncOnly'] === true
			}) ?? { label: p.label, setup: p.setup })
		}));
		const hook =
			descriptions.some((p) => p.setup.webhook === true) ||
			(transport === 'custom' && isObj(h.manifest.channels[baseOf(channel)]?.['inbound']))
				? { webhookUrl: h.webhookUrl(channel, transport) }
				: {};
		const redirect = descriptions.some((p) => p.setup.steps.some((s) => s.copy === 'redirectUrl'))
			? { redirectUrl: `${h.webhookUrl(channel, transport)}${OAUTH_CALLBACK}` }
			: {};
		const test =
			h.manifest.channels[baseOf(channel)]?.['syncOnly'] !== true &&
			held?.provider.test !== undefined &&
			base.state === 'connected'
				? { test: held.provider.test }
				: {};
		return {
			...base,
			...test,
			...(held === undefined ? {} : { provider: held.provider.id }),
			providers: descriptions.filter((p) => p.id !== WORKSPACE.id),
			about: { ...(isObj(base.about) ? base.about : {}), ...hook, ...redirect }
		};
	}
	function watch(channel: string, fn: (c: ChannelConnection) => void): () => void {
		const set = watchers.get(channel) ?? new Set();
		watchers.set(channel, set.add(fn));
		return () => {
			set.delete(fn);
		};
	}
	const changed = (channel: string) => {
		for (const w of watchers.get(channel) ?? []) w(state(channel));
	};

	async function open(
		channel: string,
		provider: ChannelProvider,
		credential: Json | null
	): Promise<ChannelLink> {
		await live
			.get(channel)
			?.link.close()
			.catch(() => undefined);
		live.delete(channel);
		const transport = provider.transport;
		const link = await provider.open({
			channel,
			credential,
			...(h.manifest.channels[baseOf(channel)]?.['syncOnly'] === true ? { syncOnly: true } : {}),
			webhookUrl: h.webhookUrl(channel, transport),
			fetch: h.fetch ?? fetch,
			save: (c) => h.store(channel, c === null ? null : { provider: provider.id, credential: c }),
			emit: (e) => {
				const base = baseOf(channel),
					account = channel === base ? null : channel.slice(base.length + 1);
				return emit(
					transport,
					account === null
						? { ...e, channel }
						: e.kind === 'inbound' && isObj(e.message)
							? {
									...e,
									channel: base,
									message: {
										...e.message,
										sourceAccount: account,
										// Attribution comes from the registry, never from the provider's payload.
										sourceUser: owners.get(base)?.[account] ?? null,
										...(transport === 'custom'
											? {}
											: {
													thread: `${account}:${String(e.message['thread'] ?? e.message['id'])}`,
													id: `${account}:${String(e.message['id'])}`
												})
									}
								}
							: { ...e, channel: base }
				);
			},
			changed: () => changed(channel)
		});
		live.set(channel, { provider, link });
		return link;
	}

	async function pair(channel: string, input: Json): Promise<void> {
		const transport = transportOf(channel);
		if (transport === undefined) throw new Error(`no channel '${channel}'`);
		const ps = choices(transport, channel),
			body = isObj(input) ? input : {};
		const named =
			typeof body['provider'] === 'string'
				? ps.find((p) => p.id === body['provider'])
				: ps.length === 1
					? ps[0]
					: undefined;
		if (named === undefined)
			throw new Error(
				`choose how to connect this ${transport} channel: ${ps.map((p) => p.id).join(', ')}`
			);
		const { provider: _p, ...rest } = body;
		const held = live.get(channel);
		const link = held?.provider === named ? held.link : await open(channel, named, null);
		try {
			await link.pair(rest);
		} catch (e) {
			if (held?.provider !== named) {
				live.delete(channel);
				await link.close().catch(() => undefined);
			}
			throw e;
		} finally {
			changed(channel);
		}
	}

	async function unpair(channel: string): Promise<void> {
		const held = live.get(channel);
		live.delete(channel);
		await held?.link.unpair().catch((e: unknown) => log(`${channel}: unpair: ${messageOf(e)}`));
		await held?.link.close().catch(() => undefined);
		await h.store(channel, null);
		changed(channel);
	}

	/** A short test message through the connected link: to `to`, or to the connected account itself when the provider names no target. */
	async function test(channel: string, to: string | null): Promise<unknown> {
		if (h.manifest.channels[baseOf(channel)]?.['syncOnly'] === true)
			throw new Error('Personal activity channels cannot send test messages.');
		const held = live.get(channel),
			c = held?.link.connection();
		if (held === undefined || c?.state !== 'connected' || held.provider.test === undefined)
			throw new Error('this channel cannot send a test message now');
		// the provider's own round trip (an email channel sends to itself and reads it back)
		if (held.link.test !== undefined) return held.link.test(AbortSignal.timeout(60_000));
		const target = held.provider.test.to === undefined ? (c.pairedAs ?? null) : to?.trim() || null;
		if (target === null) throw new Error('name where the test message goes');
		const text = 'Norbital test message: this channel is connected.';
		return held.link.send(
			channel,
			held.provider.transport === 'email'
				? { id: crypto.randomUUID(), to: [target], subject: 'Norbital test message', text }
				: { id: crypto.randomUUID(), to: target, text },
			AbortSignal.timeout(30_000)
		);
	}

	/** The engine's ports: one per declared transport, sending through the named channel's link. */
	const transports: Transports = Object.fromEntries(
		[...new Set(Object.keys(h.manifest.channels).map(transportOf))]
			.filter((t): t is string => t !== undefined && t !== 'inbox')
			.map((t): [string, TransportPort] => [
				t,
				{
					async send(channel, message, signal, attachments) {
						const held = live.get(channel);
						if (held === undefined) throw new Error(`the ${channel} channel is not connected`);
						return held.link.send(channel, message, signal, attachments);
					},
					async typing(channel, to, signal) {
						await live.get(channel)?.link.typing?.(channel, to, signal);
					},
					subscribe(sink) {
						const set = sinks.get(t) ?? new Set();
						sinks.set(t, set.add(sink));
						return () => {
							set.delete(sink);
						};
					}
				}
			])
	);

	return {
		transports,
		state,
		pair,
		unpair,
		test,
		transportOf,
		/** Reopens every channel whose sealed credential names a provider this host registers; one failure is logged. */
		async resume(): Promise<void> {
			for (const [channel, spec] of Object.entries(h.manifest.channels)) {
				if (spec['accounts'] !== true) continue;
				const saved = await h.load(`accounts:${channel}`);
				const savedOwners = await h.load(`account_owners:${channel}`);
				owners.set(
					channel,
					isObj(savedOwners)
						? Object.fromEntries(
								Object.entries(savedOwners).filter(
									(entry): entry is [string, string] => typeof entry[1] === 'string'
								)
							)
						: {}
				);
				accounts.set(
					channel,
					new Set(
						Array.isArray(saved)
							? saved.filter(
									(id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id)
								)
							: []
					)
				);
			}
			await Promise.all(
				[
					...Object.keys(h.manifest.channels),
					...[...accounts].flatMap(([base, ids]) => [...ids].map((id) => `${base}~${id}`))
				].map(async (channel) => {
					try {
						const sealed = await h.load(channel);
						if (!isObj(sealed)) return;
						const p = choices(transportOf(channel) ?? '', channel).find(
							(x) => x.id === sealed['provider']
						);
						if (p === undefined)
							return log(
								`${channel}: sealed for provider '${String(sealed['provider'])}', which this host does not register`
							);
						await open(channel, p, sealed['credential'] ?? null);
						changed(channel);
					} catch (e) {
						log(`${channel}: not resumed: ${messageOf(e)}`);
					}
				})
			);
		},
		watch,
		/** Inbound HTTP for `channel` (`/hooks/bolt.<transport>/<channel>`): the link checks the signature; 404 unpaired. */
		async webhook(channel: string, request: Request): Promise<Response> {
			const link = live.get(channel)?.link;
			if (link?.webhook === undefined) return new Response(null, { status: 404 });
			try {
				return await link.webhook(request);
			} catch (e) {
				log(`${channel}: webhook not delivered: ${messageOf(e)}`);
				return new Response(null, { status: 500 }); // not stored: the provider redelivers
			}
		},
		/** Host shutdown: sockets close, credentials stay sealed. */
		async close(): Promise<void> {
			const all = [...live.values()];
			live.clear();
			await Promise.all(all.map((x) => x.link.close().catch(() => undefined)));
		},
		/**
		 * `/__bolt/transports/<channel>[/pair|/logout]` for an administrator the host already authorised: `GET` the
		 * state (or its SSE stream), `POST …/pair` the setup input, `POST …/test` `{ to? }` a test message, `POST …/logout`.
		 * Every answer is the one `ChannelConnection`.
		 */
		async admin(
			request: Request,
			channel: string,
			verb: string,
			authority?: Authority
		): Promise<Response> {
			const member =
				authority?.actor.kind === 'member' && !authority.actor.external
					? authority.actor
					: undefined;
			const administrator = authority === undefined || (member !== undefined && authority.admin);
			const base = baseOf(channel),
				spec = h.manifest.channels[base];
			if (
				!administrator &&
				(member === undefined ||
					spec?.['accounts'] !== true ||
					spec['syncOnly'] !== true ||
					(verb !== 'accounts' &&
						verb !== 'providers' &&
						owners.get(base)?.[channel.slice(base.length + 1)] !== member.id))
			)
				return refuse(
					403,
					'forbidden',
					'Only the account owner or an administrator manages a personal channel account.'
				);
			if (verb === 'providers' && channel === base && request.method === 'GET')
				return spec === undefined
					? refuse(404, 'notFound', 'Unknown channel.')
					: Response.json({ value: state(channel).providers ?? [] });
			if (verb === 'accounts' && h.manifest.channels[channel]?.['accounts'] === true) {
				const previous = registration;
				let release = () => {};
				registration = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previous;
				try {
					const ids = new Set(accounts.get(channel));
					if (request.method === 'POST') {
						const body: unknown = await request.json().catch(() => null);
						if (
							!isObj(body) ||
							typeof body['id'] !== 'string' ||
							!/^[a-zA-Z0-9_-]{1,80}$/.test(body['id'])
						)
							return refuse(
								400,
								'invalid',
								'Account id must contain 1–80 letters, digits, underscores or hyphens.'
							);
						if (
							ids.has(body['id']) &&
							!administrator &&
							owners.get(channel)?.[body['id']] !== member!.id
						)
							return refuse(403, 'forbidden', 'This account belongs to another member.');
						if (!ids.has(body['id']) && member !== undefined) {
							const owned = { ...owners.get(channel), [body['id']]: member.id };
							await h.store(`account_owners:${channel}`, owned);
							owners.set(channel, owned);
						}
						ids.add(body['id']);
						await h.store(`accounts:${channel}`, [...ids]);
						accounts.set(channel, ids);
					} else if (request.method !== 'GET') return refuse(405, 'invalid', 'Use GET or POST.');
					return Response.json({
						value: [...ids]
							.filter((id) => administrator || owners.get(channel)?.[id] === member!.id)
							.map((id) => ({
								id,
								owner: owners.get(channel)?.[id] ?? null,
								connection: state(`${channel}~${id}`)
							}))
					});
				} finally {
					release();
				}
			}
			const transport = transportOf(channel);
			if (transport === undefined)
				return refuse(404, 'notFound', `this workspace declares no channel '${channel}'`);
			if (choices(transport, channel).length === 0)
				return refuse(503, 'unavailable', `this host has no provider for a ${transport} channel`);
			if (request.method === 'GET' && verb === '') {
				if (!(request.headers.get('accept') ?? '').includes('text/event-stream'))
					return Response.json({ value: state(channel) });
				let off = () => {};
				const enc = new TextEncoder();
				return new Response(
					new ReadableStream<Uint8Array>({
						start(ctl) {
							const send = (c: ChannelConnection) => {
								try {
									ctl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
								} catch {
									off();
								}
							};
							send(state(channel));
							off = watch(channel, send);
						},
						cancel() {
							off();
						}
					}),
					{ headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } }
				);
			}
			if (request.method === 'POST' && verb === 'pair') {
				try {
					await pair(channel, (await request.json().catch(() => ({}))) as Json);
				} catch (e) {
					return refuse(400, 'invalid', messageOf(e));
				}
				return Response.json({ value: state(channel) });
			}
			if (request.method === 'POST' && verb === 'test') {
				const body = (await request.json().catch(() => ({}))) as Json;
				try {
					await test(channel, isObj(body) && typeof body['to'] === 'string' ? body['to'] : null);
				} catch (e) {
					return refuse(400, 'invalid', messageOf(e));
				}
				return Response.json({ value: state(channel) });
			}
			if (request.method === 'POST' && verb === 'logout') {
				await unpair(channel);
				return Response.json({ value: state(channel) });
			}
			return refuse(404, 'notFound', 'no such transport route');
		}
	};
}
export type ChannelLinks = ReturnType<typeof channelLinks>;
