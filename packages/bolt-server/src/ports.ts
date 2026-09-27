// The self-host implementations of the engine's generic host ports (§2.3 decision 6, rule 71): local files, sealed
// secrets, the in-process deadlines timekeeper, an OpenAI-compatible model port, a Nominatim geocoder, and the
// automation facility dispatcher. Optional ports are simply absent when unconfigured (P19): the engine answers
// `Unavailable`.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decisionsSystem1, encodeFiles, inferFacility, openAiChat, structuredSystem1, type AiPort, type Blob, type CrossAnswer, type CrossCall, type DeadlinesPort, type FilesPort, type GeocoderPort, type GeoHit, type Json, type TenantDb, type WebReadPort } from '@norbital-ai/bolt/engine';
import type { AiModel, Config, Modality } from './config.ts';
import { readPublicPage, type PublicPage } from './web.ts';

// ── files: one directory, server-minted keys ──
const KEY = /^[0-9a-f-]{36}$/;
export function localFiles(root: string): FilesPort {
	const path = (key: string) => { if (!KEY.test(key)) throw new Error('not a file key'); return join(root, key); };
	return {
		async put(bytes, meta): Promise<Blob> {
			await mkdir(root, { recursive: true });
			const key = randomUUID();
			await writeFile(path(key), bytes);
			return { key, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), mime: meta.mime };
		},
		async get(key, max) {
			if ((await stat(path(key))).size > max) throw Object.assign(new Error(`the file is larger than ${max} bytes`), { code: 'invalid' });
			return new Uint8Array(await readFile(path(key)));
		},
		// ponytail: local blobs have no public URL; the browser downloads through `/__bolt/files/<id>`. Signed URLs land with s3.
		url: async () => { throw new Error('local files have no direct URL'); },
		remove: (key) => rm(path(key), { force: true }),
	};
}

// ── files: an S3-compatible bucket (`BOLT_FILES_PROVIDER=s3`: R2, MinIO, AWS), SigV4 over fetch ──
/**
 * `endpoint` is the bucket's URL, path style (`https://<host>/<bucket>`) or host style (`https://<bucket>.s3.<region>.amazonaws.com`),
 * with an optional `?region=` (default `us-east-1`; R2 takes `auto`); `credential` is `<access key id>:<secret>`.
 */
export function s3Files(endpoint: string, credential: string, f: typeof fetch = fetch, now: () => Date = () => new Date()): FilesPort {
	const base = new URL(endpoint);
	const region = base.searchParams.get('region') ?? 'us-east-1';
	base.search = '';
	const colon = credential.indexOf(':');
	const [id, secret] = [credential.slice(0, colon), credential.slice(colon + 1)];
	const object = (key: string) => { if (!/^[\w-]+(\.\w+)?$/.test(key)) throw new Error('not a file key'); return new URL(`${base.pathname.replace(/\/$/, '')}/${key}`, base); };
	const signed = (method: string, url: URL, headers: { [k: string]: string }, payload: string, presign?: number) => {
		const t = now().toISOString().replace(/[-:]|\.\d{3}/g, ''), day = t.slice(0, 8), scope = `${day}/${region}/s3/aws4_request`;
		const h: { [k: string]: string } = { host: url.host, ...headers };
		if (presign === undefined) Object.assign(h, { 'x-amz-content-sha256': payload, 'x-amz-date': t });
		const names = Object.keys(h).sort(), signedHeaders = names.join(';');
		if (presign !== undefined) for (const [k, v] of Object.entries({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${id}/${scope}`,
			'X-Amz-Date': t, 'X-Amz-Expires': String(presign), 'X-Amz-SignedHeaders': signedHeaders })) url.searchParams.set(k, v);
		const enc = (x: string) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
		const query = [...url.searchParams].map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join('&');
		const request = [method, url.pathname, query, names.map((n) => `${n}:${h[n]!.trim()}\n`).join(''), signedHeaders, payload].join('\n');
		const hmac = (k: Buffer | string, x: string) => createHmac('sha256', k).update(x).digest();
		const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
		const signature = hmac(key, ['AWS4-HMAC-SHA256', t, scope, createHash('sha256').update(request).digest('hex')].join('\n')).toString('hex');
		if (presign !== undefined) { url.searchParams.set('X-Amz-Signature', signature); return h; }
		return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
	};
	const call = async (method: string, key: string, signal: AbortSignal, body?: Uint8Array, mime?: string) => {
		const url = object(key), payload = createHash('sha256').update(body ?? new Uint8Array()).digest('hex');
		const headers = signed(method, url, mime === undefined ? {} : { 'content-type': mime }, payload);
		delete headers['host'];
		const res = await f(url, { method, headers, signal, ...(body === undefined ? {} : { body: new Uint8Array(body) }) });
		if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`the files store answered ${res.status} to ${method}: ${(await res.text()).slice(0, 300)}`);
		return res;
	};
	return {
		async put(bytes, meta, signal): Promise<Blob> {
			const key = randomUUID();
			await call('PUT', key, signal, bytes, meta.mime);
			return { key, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), mime: meta.mime };
		},
		async get(key, max, signal) {
			const res = await call('GET', key, signal);
			if (Number(res.headers.get('content-length') ?? 0) > max) { await res.body?.cancel(); throw Object.assign(new Error(`the file is larger than ${max} bytes`), { code: 'invalid' }); }
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (bytes.byteLength > max) throw Object.assign(new Error(`the file is larger than ${max} bytes`), { code: 'invalid' });
			return bytes;
		},
		async url(key, expiresInS) { const u = object(key); signed('GET', u, {}, 'UNSIGNED-PAYLOAD', expiresInS); return u.href; },
		async remove(key) { await call('DELETE', key, AbortSignal.timeout(30_000)); },
	};
}

// ── deadlines (rule 52a): one next-due instant per scope in memory, one unrefed timer, one wake lane; no polling ──
const MAX_TIMEOUT_MS = 2_147_483_647; // Node's largest timer delay
export function timekeeper(wake: (scope: string) => Promise<void>, now: () => number = Date.now): DeadlinesPort & { stop(): void } {
	const due = new Map<string, number>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active: string | undefined, retired = false, stopped = false;
	let answer: number | null | undefined;
	function arm(): void {
		clearTimeout(timer);
		timer = undefined;
		if (stopped || active !== undefined || due.size === 0) return;
		const delay = Math.max(0, Math.min(...due.values()) - now());
		timer = setTimeout(() => { timer = undefined; if (delay > MAX_TIMEOUT_MS) arm(); else void drain(); }, Math.min(delay, MAX_TIMEOUT_MS));
		timer.unref();
	}
	async function drain(): Promise<void> {
		if (stopped || active !== undefined) return;
		let scope: string | undefined, earliest = Infinity;
		for (const [k, at] of due) if (at <= now() && at < earliest) { scope = k; earliest = at; }
		if (scope === undefined) return arm();
		due.delete(scope);
		active = scope;
		retired = false;
		answer = undefined;
		try { await wake(scope); } catch (e) {
			// a failed wake (the database away) tries again in a minute: backoff, not a poll of an idle workspace; a wake a
			// shutdown interrupted (the database closed under it) is a lost lease the next start re-queues (rule 71a), not a failure
			if (!stopped) console.error(`[bolt] wake ${scope} failed`, e);
			answer = now() + 60_000;
		}
		// the wake's answer merges with what was announced while it ran; a teardown or stop overtook it: drop it
		const announced = due.get(scope), at = answer ?? undefined;
		const next = at === undefined ? announced : announced === undefined ? at : Math.min(at, announced);
		if (!stopped && !retired) { if (next === undefined) due.delete(scope); else due.set(scope, next); }
		active = undefined;
		void drain();
	}
	return {
		announce(scope, notLaterThan) {
			const at = Date.parse(notLaterThan), held = due.get(scope);
			if (stopped || (held !== undefined && held <= at)) return;
			due.set(scope, at);
			arm();
		},
		settle(scope, nextDue) {
			const at = nextDue === null ? null : Date.parse(nextDue);
			if (active === scope) { answer = at; return; }
			if (stopped) return;
			if (at === null) due.delete(scope); else due.set(scope, at);
			arm();
		},
		teardown(scope) {
			due.delete(scope);
			if (active === scope) retired = true; else arm();
		},
		stop() { stopped = true; clearTimeout(timer); },
	};
}

// ── AI: any OpenAI-compatible endpoint (`BOLT_AI_SYS_1_PROVIDER`, `BOLT_AI_SYS_2_PROVIDER`, `BOLT_AI_EMBED_PROVIDER` = openai) ──
const modelOf = (m: AiModel) => typeof m === 'string' ? m : m.model;
export type Endpoint = { endpoint: string; credential?: string | undefined };
const poster = (e: Endpoint, f: typeof fetch) => async (path: string, body: unknown, signal: AbortSignal) => {
	const res = await f(`${e.endpoint.replace(/\/$/, '')}${path}`, { method: 'POST', signal, body: JSON.stringify(body),
		headers: { 'content-type': 'application/json', ...(e.credential === undefined ? {} : { authorization: `Bearer ${e.credential}` }) } });
	const text = await res.text();
	if (!res.ok) throw Object.assign(new Error(`${res.status} ${text.slice(0, 500)}`), { status: res.status });
	return JSON.parse(text) as { [k: string]: unknown };
};
const dataUrl = (f: { mime: string; bytes: Uint8Array }) => `data:${f.mime};base64,${Buffer.from(f.bytes).toString('base64')}`;
/**
 * The AI facility (P35, P39): `sys_1` on `BOLT_AI_SYS_1_*` (`BOLT_AI_SYS_1_MODEL`, text only) answering P37's typed
 * decisions — `openai`: a structured-output chat model of the operator's choice; `decisions`: OpenRouter's Decisions API; `sys_2` on `BOLT_AI_SYS_2_*`, the LLM, by class
 * (`BOLT_AI_SYS_2_MODELS`); `embed` on `BOLT_AI_EMBED_*` when set (`BOLT_AI_EMBED_MODELS`), a `$file` input sent as an
 * image or file part. Every `sys_2` and embed model takes images: `aiModalityRefusals` checks it before start.
 */
export function openAi(e: { sys1: Endpoint & { provider?: string }; sys2: Endpoint; embed?: Endpoint | undefined }, ai: Config['ai'], declared: readonly string[],
	f: typeof fetch = fetch): AiPort {
	const embed = e.embed === undefined ? undefined : poster(e.embed, f);
	return {
		sys_1: e.sys1.provider === 'decisions' ? decisionsSystem1({ url: e.sys1.endpoint, model: ai.sys1 ?? '', apiKey: e.sys1.credential ?? '' }, f)
			: structuredSystem1(openAiChat({ ...e.sys1, models: { sys_1: ai.sys1 ?? '' } }, f), 'sys_1'),
		sys_2: { models: declared.filter((c) => ai.sys2[c] !== undefined), infer: openAiChat({ ...e.sys2, models: ai.sys2 }, f) },
		...(embed === undefined ? {} : { async embed(inputs, model, signal, dimensions) {
			// `default` (a `ctx.ai.embed` without `model`) is the first mapped embedding
			const m = ai.embed[model] ?? (model === 'default' ? Object.values(ai.embed)[0] : undefined);
			if (m === undefined) throw new Error(`no model is mapped to the embedding '${model}'`);
			const per = typeof m === 'string' ? 1 : m.inputs ?? 1;
			// ponytail: a file as an OpenAI-style image/file content part; adjust per provider when one documents another shape
			const parts = encodeFiles(inputs, (x) => x.mime.startsWith('image/') ? { type: 'image_url', image_url: { url: dataUrl(x) } }
				: { type: 'file', file: { filename: x.name, file_data: dataUrl(x) } }) as Json[];
			// a file goes in the multimodal shape, one `{ content }` per input (a bare part is refused); text alone stays strings
			const wire = inputs.every((x) => typeof x === 'string') ? parts : parts.map((p) => ({ content: [typeof p === 'string' ? { type: 'text', text: p } : p] }));
			const out: number[][] = [];
			for (let i = 0; i < wire.length; i += per) {
				const j = await embed('/embeddings', { model: modelOf(m), input: wire.slice(i, i + per), ...(dimensions === undefined ? {} : { dimensions }) }, signal);
				out.push(...(j['data'] as { embedding: number[] }[]).map((d) => d.embedding));
			}
			return out;
		} }),
	};
}

/**
 * P39 at activation: every `sys_2` and embed model must take images, by the provider's published model metadata
 * (`GET <endpoint>/models`, `architecture.input_modalities`, as OpenRouter publishes it), else by the operator's
 * declaration. Returns one message per refused model, naming the system, the model id and its modalities.
 */
export async function aiModalityRefusals(checks: readonly { system: 'sys_2' | 'embed'; endpoint: Endpoint; models: readonly string[]; declared: readonly Modality[] | null }[],
	f: typeof fetch = fetch): Promise<string[]> {
	const out: string[] = [];
	for (const c of checks) {
		const meta = new Map<string, readonly string[]>();
		try {
			const res = await f(`${c.endpoint.endpoint.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(10_000),
				headers: c.endpoint.credential === undefined ? {} : { authorization: `Bearer ${c.endpoint.credential}` } });
			const j = res.ok ? await res.json() as { data?: { id?: unknown; architecture?: { input_modalities?: unknown } }[] } : {};
			for (const d of j.data ?? []) if (typeof d.id === 'string' && Array.isArray(d.architecture?.input_modalities)) meta.set(d.id, d.architecture.input_modalities.map(String));
		} catch { /* no metadata: the declaration decides */ }
		for (const id of new Set(c.models)) {
			const mods = meta.get(id) ?? c.declared;
			if (mods?.includes('image') === true) continue;
			const env = c.system === 'sys_2' ? 'BOLT_AI_SYS_2_MODALITIES' : 'BOLT_AI_EMBED_MODALITIES';
			out.push(`${c.system} model '${id}' ${mods === null ? `has no published input modalities and ${env} is unset` : `takes ${mods.join(', ') || 'nothing'}`}: it must take image (P39)`);
		}
	}
	return out;
}

// ── geocoder: a Nominatim-compatible endpoint (`BOLT_GEO_PROVIDER=nominatim`) ──
export function nominatim(endpoint: string, f: typeof fetch = fetch): GeocoderPort {
	const base = endpoint.replace(/\/$/, '');
	const hit = (x: { lat: string; lon: string; name?: string; display_name: string }): GeoHit =>
		({ point: { lat: Number(x.lat), lng: Number(x.lon) }, label: x.name || x.display_name, address: x.display_name });
	const get = async (path: string, signal: AbortSignal) => {
		const res = await f(`${base}${path}`, { signal, headers: { 'user-agent': 'bolt-server' } });
		if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
		return res.json() as Promise<unknown>;
	};
	return {
		search: async (q, signal) => ((await get(`/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, signal)) as Parameters<typeof hit>[0][]).map(hit),
		async reverse(p, signal) {
			const x = await get(`/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lng}`, signal) as Parameters<typeof hit>[0] & { error?: string };
			return x.error === undefined ? hit(x) : null;
		},
	};
}

// ── the automation facilities (`ctx.ai`, `ctx.geo`); the rest answer `unavailable` (P19) ──
const unavailable = (facility: string): CrossAnswer => ({ ok: false, error: { kind: 'unavailable', facility, reason: `the host provides no ${facility}` } });
export function facilities(ports: { ai?: AiPort; geocoder?: GeocoderPort; web?: WebReadPort; files?: FilesPort; db: TenantDb }) {
	const load = async (fileId: string, signal: AbortSignal) => {
		const [r] = await ports.db.read([{ text: `SELECT key, mime FROM sys_file WHERE id = $1`, params: [fileId] }]);
		const row = r!.rows[0];
		if (row === undefined || ports.files === undefined) throw new Error(`no file ${fileId}`);
		return { mime: String(row['mime']), bytes: await ports.files.get(String(row['key']), 20 * 1024 * 1024, signal) };
	};
	const infer = inferFacility(ports.ai, { load });
	return async (call: Extract<CrossCall, { op: 'facility' }>, signal: AbortSignal): Promise<CrossAnswer> => {
		if (call.facility === 'ai' && call.method === 'sys_2.infer') return infer(call, signal);
		if (call.facility === 'geo') {
			const g = ports.geocoder;
			if (g === undefined) return unavailable('geo');
			try {
				if (call.method === 'search') return { ok: true, value: await g.search(String(call.args[0] ?? ''), signal) as unknown as Json };
				if (call.method === 'reverse') return { ok: true, value: await g.reverse(call.args[0] as never, signal) as unknown as Json };
			} catch (e) {
				return { ok: false, error: { kind: 'upstream', message: e instanceof Error ? e.message : 'the geocoder failed' } };
			}
		}
		if (call.facility === 'web' && call.method === 'read') {
			if (ports.web === undefined) return unavailable('web');
			const options = call.args[1] as { raw?: unknown } | undefined;
			try { return { ok: true, value: await ports.web.read(String(call.args[0] ?? ''), signal, { raw: options?.raw === true }) as unknown as Json }; }
			catch (e) { return { ok: false, error: { kind: 'upstream', message: e instanceof Error ? e.message : 'the page could not be read' } }; }
		}
		return unavailable(`${call.facility}.${call.method}`);
	};
}

/** A page's `href`s as absolute http(s) URLs, once each, fragments dropped, at most 1,000. */
const linksOf = (html: string, base: string): string[] => [...new Set([...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)].flatMap(([, href]) => {
	const u = URL.parse(href!.trim(), base);
	if (u === null || !/^https?:$/.test(u.protocol)) return [];
	u.hash = '';
	return u.href === URL.parse(base)?.href.replace(/#.*$/, '') ? [] : [u.href];
}))].slice(0, 1_000);

// ── web reads (`BOLT_WEB_PROVIDER=public`): the pinned-DNS public page reader (HTTPS only, no private networks) ──
export function publicWeb(fetchPage: (url: string, signal: AbortSignal) => Promise<PublicPage> = readPublicPage): WebReadPort {
	return {
		async read(url, signal, options = {}) {
			const out = await fetchPage(url, signal);
			const title = /<title[^>]*>([^<]*)<\/title>/i.exec(out.body)?.[1]?.trim() ?? null;
			// ponytail: tags stripped by regex; a readability pass when pages read badly
			const text = out.body.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
			// the markup and its links (a crawl) only when asked, and only for a page that is markup (a PDF's body is its text)
			const html = options.raw === true && /html|xml/i.test(out.contentType ?? 'text/html') ? out.body : undefined;
			return { url: out.url, title, text: text.slice(0, 200_000),
				...(out.contentType === undefined ? {} : { contentType: out.contentType }), ...(out.sha256 === undefined ? {} : { sha256: out.sha256 }),
				...(out.pageCount === undefined ? {} : { pages: out.pageCount }), ...(html === undefined ? {} : { html, links: linksOf(html, out.url) }) };
		},
	};
}
