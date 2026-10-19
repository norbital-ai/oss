// A host for one link, as bolt's `integrationLinks` would be: a fake fetch that records every call and answers from a
// route table, the instance's credentials (each write recorded and applied), emitted events, reported statuses and pairings.
import { randomUUID } from 'node:crypto';
import { Effect, FiberSet, Semaphore } from 'effect';
import { FirstSyncs, ProviderRuntime, type ProviderDef, type LinkDef } from '../src/abi.ts';
import { ProviderUnavailable } from '../src/errors.ts';
import {
	oauthClientOf,
	type DriverEvent,
	type DriverOpen,
	type Json,
	type LinkStatus,
	type OAuthClient,
	type Pairing
} from '@norbital-ai/bolt/engine';

/** `form`: a multipart body as sent; `body` is then empty. */
export type Call = {
	url: string;
	method: string;
	headers: { [k: string]: string };
	body: string;
	form?: FormData;
};
export type Route = (call: Call) => Response | Promise<Response> | undefined;

export function fakeFetch(routes: Route[]): typeof fetch & { calls: Call[] } {
	const calls: Call[] = [];
	const f: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const headers: { [k: string]: string } = {};
		request.headers.forEach((v, k) => {
			headers[k] = v;
		});
		const form =
			request.headers.get('content-type')?.startsWith('multipart/form-data') === true
				? await request.formData()
				: undefined;
		const body = form === undefined ? await request.text() : '';
		const call = {
			url: request.url,
			method: request.method,
			headers,
			body,
			...(form === undefined ? {} : { form })
		};
		calls.push(call);
		for (const r of routes) {
			const got = await r(call);
			if (got !== undefined) return got;
		}
		return new Response('no route', { status: 599 });
	};
	return Object.assign(f, { calls });
}

export const HOOK = 'https://ws.example/acme/hooks/integration/desk';
/** The host's one OAuth callback; a state the kit mints names the instance, as bolt's links manager's does. */
export const REDIRECT = 'https://ws.example/acme/hooks/oauth/callback';
export type HostOptions = {
	webhookUrl?: string;
	redirectUrl?: string;
	personal?: boolean;
	definition?: DriverOpen['definition'];
	configuration?: Json;
	secrets?: { readonly [name: string]: string };
	/** The host's own Google client, used where the definition names none. */
	google?: OAuthClient;
	/** Before an event is recorded; a rejection is the engine refusing it. */
	emit?: (e: DriverEvent) => Promise<void>;
	/** Before a credential write lands; a rejection is the write refused (a fence). */
	write?: (changes: ReadonlyMap<string, Json | null>) => Promise<void>;
};
export type Host = {
	link: LinkDef;
	/** The instance's credentials now. */
	values: Map<string, Json>;
	writes: ReadonlyMap<string, Json | null>[];
	events: DriverEvent[];
	statuses: LinkStatus[];
	/** The last status the link reported. */
	status: LinkStatus | undefined;
	pairing: Pairing | null;
	controller: AbortController;
};

/** Opens `provider`'s link for the instance `desk` with `stored` credentials. */
export const host = Effect.fn('ProviderTest.host')(function* (
	provider: ProviderDef,
	f: typeof fetch,
	stored: { readonly [name: string]: Json } = {},
	o: HostOptions = {}
) {
	const values = new Map(Object.entries(stored)),
		writes: ReadonlyMap<string, Json | null>[] = [],
		events: DriverEvent[] = [],
		statuses: LinkStatus[] = [];
	const controller = new AbortController();
	const callbackRun = yield* FiberSet.makeRuntimePromise<never>();
	const firstSyncs = yield* Semaphore.make(2);
	let status: LinkStatus | undefined,
		pairing: Pairing | null = null;
	const definition = o.definition ?? { description: 'Desk', driver: provider.driver };
	const link = yield* provider
		.open({
			instance: 'desk',
			definition,
			personal: o.personal === true,
			configuration: o.configuration ?? {},
			webhookUrl: o.webhookUrl ?? HOOK,
			redirectUrl: o.redirectUrl ?? REDIRECT,
			state: () => `${randomUUID()}.desk`,
			signal: controller.signal,
			fetch: f,
			oauthClient: (vendor) =>
				oauthClientOf(
					definition,
					o.secrets,
					o.google === undefined ? {} : { google: o.google },
					vendor
				),
			credentials: {
				load: () => Promise.resolve(new Map(values)),
				write: async (changes) => {
					await o.write?.(changes);
					writes.push(new Map(changes));
					for (const [key, value] of changes)
						if (value === null) values.delete(key);
						else values.set(key, value);
				}
			},
			emit: async (event) => {
				await o.emit?.(event);
				events.push(event);
			},
			status: (next) => {
				statuses.push(next);
				status = next;
				return Promise.resolve();
			},
			pairing: (next) => {
				pairing = next;
			}
		})
		.pipe(
			Effect.provideService(ProviderRuntime, callbackRun),
			Effect.provideService(FirstSyncs, firstSyncs)
		);
	return {
		link,
		values,
		writes,
		events,
		statuses,
		controller,
		get status() {
			return status;
		},
		get pairing() {
			return pairing;
		}
	} satisfies Host;
});
export const json = (v: unknown, status = 200) => Response.json(v, { status });
export const signal = () => AbortSignal.timeout(5_000);
export const until = (ok: () => boolean, ms = 8000) =>
	Effect.gen(function* () {
		while (!ok()) yield* Effect.sleep('10 millis');
	}).pipe(
		Effect.timeoutOrElse({
			duration: ms,
			orElse: () => Effect.fail(new ProviderUnavailable({ message: 'timed out' }))
		})
	);
/** The messages an event carries (`[]` for any other event). */
export const messagesOf = (events: readonly DriverEvent[]) =>
	events.flatMap((e) => (e.kind === 'messages' ? e.messages : []));
/** A file bolt read for a send; `url` answers a signed link unless `link` is `null` (a host that serves none). */
export const file = (
	name: string,
	mime: string,
	text: string,
	link: string | null = `https://host.example/files/${name}?sig=x`
) => ({
	id: `f-${name}`,
	name,
	mime,
	bytes: new TextEncoder().encode(text),
	url: async () => {
		if (link === null) throw new Error('local files have no direct URL');
		return link;
	}
});
