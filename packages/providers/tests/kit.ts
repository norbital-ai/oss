// A host for one link, as bolt's `channelLinks` would be: a fake fetch that records every call and answers from a
// route table, the sealed credential, emitted events and connection changes.
import type { ChannelLink, ChannelProvider, Json, TransportEvent } from '@norbital-ai/bolt/engine';

/** `form`: a multipart body as sent; `body` is then empty. */
export type Call = { url: string; method: string; headers: { [k: string]: string }; body: string; form?: FormData };
export type Route = (call: Call) => Response | Promise<Response> | undefined;

export function fakeFetch(routes: Route[]): typeof fetch & { calls: Call[] } {
	const calls: Call[] = [];
	const f = async (input: string | URL | Request, init?: RequestInit) => {
		const headers: { [k: string]: string } = {};
		new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
		const b = init?.body;
		const body = b === undefined || b === null || b instanceof FormData ? '' : b instanceof URLSearchParams ? b.toString() : b instanceof Uint8Array ? new TextDecoder().decode(b) : String(b);
		const call = { url: String(input), method: init?.method ?? 'GET', headers, body, ...(b instanceof FormData ? { form: b } : {}) };
		calls.push(call);
		for (const r of routes) { const got = await r(call); if (got !== undefined) return got; }
		return new Response('no route', { status: 599 });
	};
	return Object.assign(f as typeof fetch, { calls });
}

export async function host(provider: ChannelProvider, f: typeof fetch, credential: Json | null = null, webhookUrl = 'https://ws.example/hooks/bolt.x/desk') {
	const h = { saved: [] as (Json | null)[], events: [] as TransportEvent[], changes: 0, link: undefined as unknown as ChannelLink };
	h.link = await provider.open({ channel: 'desk', credential, webhookUrl, fetch: f,
		save: async (c) => { h.saved.push(c); }, emit: async (e) => { h.events.push(e); }, changed: () => { h.changes++; } });
	return h;
}
export const json = (v: unknown, status = 200) => Response.json(v, { status });
export const signal = () => AbortSignal.timeout(5_000);
/** A file bolt read for a send; `url` answers a signed link unless `link` is `null` (a host that serves none). */
export const file = (name: string, mime: string, text: string, link: string | null = `https://host.example/files/${name}?sig=x`) => ({
	id: `f-${name}`, name, mime, bytes: new TextEncoder().encode(text),
	url: async () => { if (link === null) throw new Error('local files have no direct URL'); return link; } });
