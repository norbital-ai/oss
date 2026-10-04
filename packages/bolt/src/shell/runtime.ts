// The shell's browser half (§3.5, §5.10): `$bolt` as pages see it (the data client plus `href` and `agent`), the
// shell's own routes, and the visitor fetch that names the page's app and spends one Turnstile token per request that
// needs one. The generated `$bolt` module is `export const bolt = shellBolt(boot)`.
import type { Json } from '../decl/values.ts';
import type { InputKind, ValueOf } from '../decl/fields.ts';
import type { CollectionName, CustomFieldName, CustomShape, Row as RowOf } from '../decl/names.ts';
import { createBolt, type BoltConfig } from '../client/bolt.ts';
import { clientFacilities, type ClientFacilities } from '../client/facilities.ts';
import type { AiModel, Outcome } from '../engine/contracts.ts';
import {
	decodeConnection,
	type ChannelConnection,
	type ProviderChoice
} from '../engine/channels/connection.ts';
import { BOLT, HEADERS, PATHS, uuidv7, type AgentRow, type PushBody } from '../protocol/wire.ts';
import { based, BASE, href, SHELL, VISITOR_APP, type ShellBoot } from './nav.ts';

/** `workspace`: on a signed-out boot, what the access pages show (name, logo, environment). */
export type ShellError = { code: string; message: string; workspace?: ShellBoot['workspace'] };
export type Answer<T> = { ok: true; value: T } | { ok: false; error: ShellError; status: number };

/** A refused HTTP response remains an HTTP error even when a proxy returns HTML or an empty body. */
async function responseBody<T>(res: Response): Promise<{ value?: T; outcome?: Outcome; error?: ShellError }> {
	try {
		const body: unknown = await res.json();
		if (body !== null && typeof body === 'object') {
			const parsed = body as { value?: T; outcome?: Outcome; error?: ShellError };
			if (parsed.error !== undefined && (parsed.error === null || typeof parsed.error.code !== 'string' || typeof parsed.error.message !== 'string')) delete parsed.error;
			return parsed;
		}
	} catch { /* a proxy's error page is not the shell protocol */ }
	return {};
}

const requestFailure = (status: number): ShellError => ({
	code: status === 429 ? 'busy' : status >= 500 ? 'unavailable' : 'refused',
	message: status === 429 ? 'Too many requests. Wait a moment and try again.'
		: status === 503 ? 'The workspace is temporarily unavailable. Wait a moment and try again.'
		: status === 502 || status === 504 ? 'The workspace server did not respond in time. Try again shortly.'
		: status >= 500 ? 'The workspace server could not complete the request. Try again shortly.'
		: status === 403 ? 'You do not have permission to open this workspace.'
		: status === 404 ? 'The requested workspace or page could not be found.'
		: status === 410 ? 'This link has expired. Choose your workspace and sign in again.'
		: 'The server refused the request.'
});

/** A stream frame the host did not write as JSON: nothing to show, and nothing to fail the page over. */
const safeJson = (text: string): Json => {
	try {
		return JSON.parse(text) as Json;
	} catch {
		return null;
	}
};

/** The shell routes over one `fetch`; every call answers, none rejects on a refusal. */
export function shellApi(f: typeof fetch = (i, o) => fetch(i, o)) {
	async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Json): Promise<Answer<T>> {
		try {
			const res = await f(based(path), {
				method,
				credentials: 'same-origin',
				...(body === undefined
					? {}
					: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
			});
			if (res.status === 204) return { ok: true, value: null as T };
			const b = await responseBody<T>(res);
			if (!res.ok)
				return {
					ok: false,
					error: b.error !== undefined && !['The request failed.', 'Internal Error', 'Internal Server Error'].includes(b.error.message) ? b.error : requestFailure(res.status),
					status: res.status
				};
			if (!('value' in b)) return { ok: false, error: { code: 'protocol', message: 'The server returned an unexpected response. Reload the page and try again.' }, status: res.status };
			return { ok: true, value: b.value as T };
		} catch {
			return {
				ok: false,
				error: { code: 'offline', message: 'The workspace could not be reached.' },
				status: 0
			};
		}
	}
	const q = (k: string, v: string) => `?${new URLSearchParams({ [k]: v })}`;
	/** One `/act` of the agent's callables: the outcome (a refusal included), or the wire error. */
	async function act(callable: string, input: Json): Promise<Answer<Outcome>> {
		try {
			const res = await f(based(PATHS.act), {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json', [HEADERS.key]: uuidv7() },
				body: JSON.stringify({ callable, input, issuedAt: new Date().toISOString() })
			});
			const b = await responseBody<never>(res);
			return b.outcome !== undefined
				? { ok: true, value: b.outcome }
				: {
						ok: false,
						error: b.error !== undefined && !['The request failed.', 'Internal Error', 'Internal Server Error'].includes(b.error.message) ? b.error : requestFailure(res.status),
						status: res.status
					};
		} catch {
			return {
				ok: false,
				error: { code: 'offline', message: 'The workspace could not be reached.' },
				status: 0
			};
		}
	}
	return {
		boot: (app?: string) =>
			call<ShellBoot>('GET', app === undefined ? SHELL : `${SHELL}${q('app', app)}`),
		methods: () => call<import('./host.ts').SignInMethods>('GET', PATHS.session.methods),
		sendCode: (address: string, via: 'sms' | 'whatsapp' = 'sms') =>
			call<null>('POST', PATHS.session.code, { address, via }),
		verify: (address: string, code: string) =>
			call<{ user: string }>('POST', PATHS.session.verify, { address, code }),
		signOut: () => call<null>('POST', PATHS.session.signout),
		invitation: (id: string) =>
			call<{
				email: string | null;
				phone: string | null;
				team: string | null;
				external: boolean;
				status: 'open' | 'accepted' | 'revoked' | 'expired';
			}>('GET', `${PATHS.session.invitation}/${encodeURIComponent(id)}`),
		accept: (id: string) => call<null>('POST', PATHS.session.invitation, { id }),
		inbox: () => call<import('./data.ts').Inbox>('GET', `${SHELL}/inbox`),
		markNoticesRead: (ids: readonly string[]) =>
			act('sys_notification.markRead', { ids: [...ids] }), // L-BOLT-354
		runs: (o: { automation?: string; limit?: number } = {}) =>
			call<import('./data.ts').RunRow[]>(
				'GET',
				`${SHELL}/runs${
					o.automation === undefined && o.limit === undefined
						? ''
						: `?${new URLSearchParams(
								Object.entries(o)
									.filter((e) => e[1] !== undefined)
									.map(([k, v]) => [k, String(v)])
							)}`
				}`
			),
		run: (id: string) =>
			call<import('../engine/runs/index.ts').RunView>('GET', `${SHELL}/runs${q('id', id)}`),
		stopRun: (id: string) =>
			call<import('../engine/runs/index.ts').RunView>('POST', `${SHELL}/runs/stop`, { id }), // hook:runtime
		settings: () => call<import('./data.ts').Settings>('GET', `${SHELL}/settings`),
		settingsOp: (op: string, input: Json) => call<Json>('POST', `${SHELL}/settings`, { op, input }),
		/**
		 * A channel's connection to its provider (rule 61, `connection.ts`). The host holds the socket, so this is the only
		 * place a channel can be paired; it names the channel, never the transport, so a host that answers a transport
		 * resolves the channel itself. Personal sync accounts are managed by their owner; the host enforces access.
		 */
		transport: {
			providers: (channel: string) =>
				call<ProviderChoice[]>(
					'GET',
					`${BOLT}/transports/${encodeURIComponent(channel)}/providers`
				),
			connections: () => call<import('../engine/channels/registry.ts').ChannelRecord[]>('GET', `${BOLT}/transports/`),
			saveConnection: (input: Json) => call<Json>('POST', `${BOLT}/transports/`, input),
			deleteConnection: (id: string) => call<Json>('DELETE', `${BOLT}/transports/${encodeURIComponent(id)}`),
			types: (type: string) => call<ProviderChoice[]>('GET', `${BOLT}/transports/types/${encodeURIComponent(type)}`),
			path: (channel: string) => `${BOLT}/transports/${encodeURIComponent(channel)}`,
			state: (channel: string) =>
				call<ChannelConnection>('GET', `${BOLT}/transports/${encodeURIComponent(channel)}`),
			/** The provider's setup fields as one object, plus `provider: '<id>'` when the transport has several. The host refuses a malformed one. */
			pair: (channel: string, input: Json = {}) =>
				call<ChannelConnection>(
					'POST',
					`${BOLT}/transports/${encodeURIComponent(channel)}/pair`,
					input
				),
			unpair: (channel: string) =>
				call<ChannelConnection>('POST', `${BOLT}/transports/${encodeURIComponent(channel)}/logout`),
			/** A short test message through the connected channel: to `to`, or to its own account when its provider names no target (`connection.test`). */
			test: (channel: string, to?: string) =>
				call<ChannelConnection>(
					'POST',
					`${BOLT}/transports/${encodeURIComponent(channel)}/test`,
					to === undefined ? {} : { to }
				),
			/**
			 * The host's state stream, so a pairing that takes a while (a rotating QR, a bot webhook registering) reports
			 * progress instead of a spinner: every state change arrives, and a dropped stream reconnects on its own.
			 * `EventSource` is the browser's and sends both the session cookie and the `accept` a host switches on.
			 */
			watch: (
				channel: string,
				onConnection: (c: ChannelConnection) => void,
				onFailure: (e: Event) => void
			): EventSource => {
				const stream = new EventSource(based(`${BOLT}/transports/${encodeURIComponent(channel)}`));
				stream.onmessage = (e) => {
					const c = decodeConnection(channel, safeJson(e.data));
					if (c !== null) onConnection(c);
				};
				stream.onerror = onFailure;
				return stream;
			}
		},
		/** L-COL-199: the workspace's name and logo (`null`, an `https:` URL or a `data:image/…` URL), an administrator's. */
		organization: (name: string, logo: string | null) =>
			call<null>('POST', `${SHELL}/organization`, { name, logo }),
		/** A channel's raw messages, both directions, newest first (an administrator's; the channel's Messages tab). */
		channelMessages: (channel: string, before?: string) =>
			call<import('./data.ts').ChannelMessage[]>(
				'GET',
				`${SHELL}/channel-messages?${new URLSearchParams(
					before === undefined ? { channel } : { channel, before }
				)}`
			),
		logs: (x: import('./data.ts').LogQuery) =>
			call<import('./data.ts').LogRow[]>(
				'GET',
				`${SHELL}/logs?${new URLSearchParams(
					Object.entries({
						before: x.before,
						after: x.after,
						level: x.level,
						q: x.text,
						conversation: x.conversation
					}).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '')
				)}`
			),
		studio: () => call<import('./studio.ts').StudioView>('GET', `${SHELL}/studio`),
		studioRun: (op: import('./studio.ts').StudioOp) =>
			call<import('./studio.ts').StudioView>('POST', `${SHELL}/studio`, { op } as unknown as Json),
		/** Rule 39: a member id, `{ team }`, or `null` to end the preview. */
		preview: (target: string | { team: string } | null) =>
			call<null>(
				'POST',
				`${SHELL}/preview`,
				typeof target === 'object' && target !== null ? target : { user: target }
			),
		/** `access.explain` (L-BOLT-234): the caller's own Authority, or (administrators) a member's or team's. */
		explain: (target?: { user: string } | { team: string }) =>
			call<Json>(
				'GET',
				`${SHELL}/explain${target === undefined ? '' : `?${new URLSearchParams(target)}`}`
			),
		push: (body: PushBody) => call<null>('POST', PATHS.push, body as Json),
		agent: {
			start: (title?: string, model?: string) =>
				act('sys_conversation.start', {
					...(title === undefined ? {} : { title }),
					...(model === undefined ? {} : { model })
				}),
			/** The models the member may pick and the one a new conversation runs (their conversations are the live `conversations` read). */
			models: () => call<{ models: AiModel[]; default: string }>('GET', `${PATHS.agent}/models`),
			/** `mode`: the composer's `/plan` or `/compact` (§5.9). */
			post: (
				conversation: string,
				text: string,
				now?: boolean,
				attachments: readonly Json[] = [],
				mode?: 'plan' | 'compact'
			) =>
				act('sys_message.post', {
					conversation,
					text,
					...(now === true ? { now } : {}),
					...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
					...(mode === undefined ? {} : { mode })
				}),
			/** hook:attachments — one panel attachment to `/__bolt/files/sys_message.files`: its `FileRef`, or the refusal. */
			async upload(
				file: File
			): Promise<Answer<{ id: string; name: string; mime: string; bytes: number }>> {
				try {
					const res = await f(based(`${PATHS.files}sys_message.files`), {
						method: 'PUT',
						credentials: 'same-origin',
						body: file,
						headers: {
							[HEADERS.key]: crypto.randomUUID(),
							'content-type': file.type || 'application/octet-stream',
							'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
						}
					});
					const b = (await res.json()) as
						{ id: string; name: string; mime: string; bytes: number } | { error: ShellError };
					return 'error' in b
						? { ok: false, error: b.error, status: res.status }
						: { ok: true, value: b };
				} catch {
					return {
						ok: false,
						error: { code: 'offline', message: 'The workspace could not be reached.' },
						status: 0
					};
				}
			},
			respondNow: (conversation: string) => act('sys_conversation.respondNow', { conversation }), // hook:triage
			confirm: (message: string, approve: boolean) =>
				act('sys_message.confirm', { message, approve }),
			// hook:agent-ui — §5.9's remaining generated actions
			setAgent: (conversation: string, agent: string) =>
				act('sys_conversation.setAgent', { conversation, agent }),
			file: (message: string, about: { collection: string; id: string } | null) =>
				act('sys_message.file', { message, about }),
			stop: (conversation: string) => act('sys_conversation.stop', { conversation }),
			setModel: (conversation: string, model: string) =>
				act('sys_conversation.setModel', { conversation, model }),
			revise: (message: string, text: string) => act('sys_message.revise', { message, text }),
			dequeue: (message: string) => act('sys_message.dequeue', { message }),
			reorder: (conversation: string, messages: readonly string[]) =>
				act('sys_message.reorder', { conversation, messages: [...messages] }),
			executePlan: (conversation: string) => act('sys_message.executePlan', { conversation }),
			discardPlan: (conversation: string) => act('sys_message.discardPlan', { conversation }),
			resume: (conversation: string) => act('sys_conversation.resume', { conversation }),
			transcript: (conversation: string) =>
				call<{ status: 'idle' | 'running' | 'stopped'; rows: AgentRow[] }>(
					'GET',
					`${PATHS.agent}${q('conversation', conversation)}`
				),
			/** The `limit` messages just before `seq` `before` (the panel's older page); `more`: another may lie before `first`. */
			older: (conversation: string, before: number, limit: number) =>
				call<{ rows: AgentRow[]; more: boolean; first: number }>(
					'GET',
					`${PATHS.agent}?${new URLSearchParams({ conversation, before: String(before), limit: String(limit) })}`
				)
		}
	};
}
export type ShellApi = ReturnType<typeof shellApi>;

/**
 * Turnstile tokens are single-use (GAPS r5 11): a request that needs one waits for the next token, spends it and
 * asks the widget for another. `put` is the widget's callback; `reset` re-arms the widget.
 */
export function challengeQueue(reset: () => void = () => {}) {
	const tokens: string[] = [];
	const waiting: ((token: string) => void)[] = [];
	return {
		put(token: string) {
			const w = waiting.shift();
			if (w !== undefined) w(token);
			else tokens.push(token);
		},
		async take(): Promise<string> {
			const token =
				tokens.shift() ?? (await new Promise<string>((resolve) => waiting.push(resolve)));
			reset();
			return token;
		},
		setReset(fn: () => void) {
			reset = fn;
		}
	};
}
export type ChallengeQueue = ReturnType<typeof challengeQueue>;

/** A visitor page's fetch: every `/__bolt` request names the app; an upload and a final act carry a fresh token. */
export function visitorFetch(
	app: string,
	challenge: ChallengeQueue | null,
	f: typeof fetch = (i, o) => fetch(i, o)
): typeof fetch {
	return async (input, init = {}) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const path = new URL(url, 'http://x').pathname.slice(BASE.length);
		if (!path.startsWith(`${BOLT}/`)) return f(input, init);
		const headers = new Headers(init.headers);
		headers.set(VISITOR_APP, app);
		const method = (init.method ?? 'GET').toUpperCase();
		if (
			challenge !== null &&
			((method === 'POST' && path === PATHS.act) ||
				(method === 'PUT' && path.startsWith(PATHS.files)))
		)
			headers.set(HEADERS.challenge, await challenge.take());
		return f(input, { ...init, headers });
	};
}

/** `conversation`: the one to open (`null` a new one; absent: the one this tab last had), as `?agent=` names it. */
export type AgentRequest = {
	prompt?: string;
	about?: { collection: string; id: string };
	conversation?: string | null;
};
/** The agent panel's open state; the shell renders the panel, the agent area its conversation. */
export function agentPanel() {
	let state: AgentRequest | null = null;
	const readers = new Set<(s: AgentRequest | null) => void>();
	const set = (s: AgentRequest | null) => {
		state = s;
		for (const r of readers) r(s);
	};
	return {
		open: (request: AgentRequest = {}) => set(request),
		close: () => set(null),
		subscribe(run: (s: AgentRequest | null) => void) {
			readers.add(run);
			run(state);
			return () => {
				readers.delete(run);
			};
		}
	};
}

type Row = { readonly [field: string]: Json };
type RowFor<C> = C extends CollectionName ? RowOf<C> : Row;
/** X-20: what `+representation.svelte` receives, `{ view: RecordView<'<collection>'> }` (ui's views pass the same shape). */
export type RecordView<C extends string = string> =
	| { collection: C; mode: 'update'; record: RowFor<C> }
	| { collection: C; mode: 'create'; values: Partial<RowFor<C>> };
type ViewCommon<F, V> = {
	name: F;
	value: V | null;
	row?: Row;
	kind?: InputKind;
	id?: string;
	address?: { value: string | null; onChange?(next: string | null): void };
};
/**
 * §3.2 role 5: what `+renderer.svelte` receives, `{ view: CustomFieldView<'<f>'> }`, a workspace's and a built-in's
 * (`money`, `file`, `point`, `phone`) alike. `row` is the record's other field values (the form's draft in edit mode),
 * absent when a page embeds the renderer; `kind` the field's literal (a custom reference's shape); `dense` asks for one
 * compact line (a table cell, a card); `address` is a `point` field's address sibling.
 */
export type CustomFieldView<
	F extends string = string,
	V = F extends CustomFieldName ? ValueOf<CustomShape<F>> : Json
> =
	| (ViewCommon<F, V> & { mode: 'show'; dense?: true })
	| (ViewCommon<F, V> & {
			mode: 'edit';
			disabled: boolean;
			error?: string;
			onChange(next: V | null): void;
	  });

/** Rule 56's run row as its viewer may read it (the shell's `/runs` view). */
export type PageRunRow = import('../engine/runs/index.ts').RunView;
type Live<T> = import('../client/bolt.ts').Live<T>;
const RUNS_EVERY_MS = 2_000;
/**
 * `bolt.runs(automation, { where?, limit })` (§3.5) over the shell's `/runs` routes, polled while read. `where` takes
 * `{ <field>: { eq } }` conditions only; anything else is the read's `invalid` error, never a silently wider page.
 * ponytail: polling every 2 s; ride the live stream when `sys_run` gets a live read.
 */
export function runsLive(
	api: Pick<ShellApi, 'runs' | 'run'>,
	automation: string,
	o: { where?: Json; limit: number },
	every = RUNS_EVERY_MS
): Live<{ rows: PageRunRow[]; next: null }> {
	type Page = { rows: PageRunRow[]; next: null };
	const conds = Object.entries((o.where ?? {}) as { readonly [f: string]: Json });
	const bad = conds.find(
		([, c]) =>
			c === null || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).join() !== 'eq'
	);
	const eq = new Map(conds.map(([f, c]) => [f, JSON.stringify((c as { eq: Json }).eq)]));
	const byId = eq.size === 1 && eq.has('id') ? (JSON.parse(eq.get('id')!) as string) : null;
	let current: Page | undefined,
		error: { code: string; message: string } | undefined =
			bad === undefined
				? undefined
				: {
						code: 'invalid',
						message: `runs: where takes { <field>: { eq } } conditions, not ${JSON.stringify(bad[1])} on '${bad[0]}'`
					};
	const readers = new Set<(v: Page | undefined) => void>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	async function poll(): Promise<void> {
		const r =
			byId !== null
				? await api
						.run(byId)
						.then((a) =>
							a.ok
								? { ok: true as const, value: [a.value] }
								: a.status === 404
									? { ok: true as const, value: [] }
									: a
						)
				: await api.runs({ automation, limit: o.limit });
		if (r.ok) {
			const rows = (r.value as PageRunRow[])
				.filter(
					(x) =>
						x.automation === automation &&
						[...eq].every(([f, v]) => JSON.stringify((x as unknown as Row)[f] ?? null) === v)
				)
				.slice(0, o.limit);
			current = { rows, next: null };
			error = undefined;
		} else error = { code: r.error.code, message: r.error.message };
		for (const run of readers) run(current);
		if (readers.size > 0) timer = setTimeout(() => void poll(), every);
	}
	return {
		get current() {
			return current;
		},
		get error() {
			return error;
		},
		subscribe(run) {
			readers.add(run);
			run(current);
			if (readers.size === 1 && bad === undefined) void poll();
			return () => {
				readers.delete(run);
				if (readers.size === 0) clearTimeout(timer);
			};
		}
	};
}

/** `$bolt` (§3.5): the data client plus `href` and `agent`; a visitor page's client names its app on every request. */
export function shellBolt(
	boot: ShellBoot,
	options: {
		messages?: BoltConfig['messages'];
		challenge?: ChallengeQueue;
		agent?: ReturnType<typeof agentPanel>;
		fetch?: typeof fetch;
		openStream?: BoltConfig['openStream'];
		models?: () => readonly string[];
		facilities?: ClientFacilities;
	} = {}
) {
	const visitor = boot.visitor;
	const f =
		visitor === null
			? options.fetch
			: visitorFetch(
					visitor.app,
					visitor.siteKey === undefined ? null : (options.challenge ?? null),
					options.fetch
				);
	const client = createBolt({
		base: BASE,
		actor: boot.actor as Json,
		locale: boot.workspace.locale,
		catalog: boot.catalog,
		/* hook:query (bolt.decode) */ describe: boot.visitor === null && boot.aiUnconfigured !== true,
		/* hook:decisions (rule 16a) */ ...(options.messages === undefined
			? {}
			: { messages: options.messages }),
		...(f === undefined ? {} : { fetch: f }),
		...(options.openStream === undefined ? {} : { openStream: options.openStream }),
		...(boot.contract === undefined ? {} : { contract: boot.contract })
	});
	const agent = options.agent ?? agentPanel();
	const api = shellApi(options.fetch);
	return Object.assign(client, {
		facilities: clientFacilities(options.facilities),
		/** The path of an app page, optionally opening a record: `bolt.href(app, page?, record?)`. */
		href: (...a: Parameters<typeof href>) => based(href(...a)),
		/** The page's organization: the workspace name and its brand logo (the host's first icon), or `null`. */
		org: { name: boot.workspace.name, logo: boot.workspace.logo ?? null },
		/** `bolt.runs(automation, …)`, and `bolt.runs.stop(id)`: the run as stopped, rejecting when it is not found or not the caller's to stop. */ // hook:runtime
		runs: Object.assign(
			(automation: string, o: { where?: Json; limit: number }) => runsLive(api, automation, o),
			{
				stop: async (id: string): Promise<PageRunRow> => {
					const r = await api.stopRun(id);
					if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
					return r.value;
				}
			}
		),
		/** The agent panel: `open` it (optionally with a request), and the model classes the host offers. */
		agent: {
			open: (request: AgentRequest = {}) => {
				if (boot.surfaces.agent) agent.open(request);
			},
			models: () => options.models?.() ?? []
		}
	});
}
export type ShellBolt = ReturnType<typeof shellBolt>;

// Pages load after the boot, so the generated `$bolt` (`export const bolt = currentBolt()`) reads the booted client.
let current: ShellBolt | null = null;
export const setCurrentBolt = (b: ShellBolt) => {
	current = b;
};
export function currentBolt(): ShellBolt {
	if (current === null) throw new Error('$bolt was read before the workspace shell booted.');
	return current;
}
/**
 * `$bolt` (§3.5) as a module value: read on use, never at import, so a module that imports it (a representation the
 * record view loads, a `lib/` helper) evaluates before the shell boots. A member read before the boot still throws.
 */
export const bolt: ShellBolt = new Proxy({} as ShellBolt, {
	get(_, key) {
		const b = currentBolt() as unknown as { [k: PropertyKey]: unknown };
		const v = b[key];
		return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(b) : v;
	},
	has: (_, key) => current !== null && key in current
});
