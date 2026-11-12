// The shell's browser half (§3.5, §5.10): the page context (the data client plus `href` and `agent`), the
// shell's own routes, and the visitor fetch that names the page's app and spends one Turnstile token per request that
// needs one.
import { Clock, Context, Effect, Equal, Layer, Option, Queue, Schema, Stream } from 'effect';
import { encode_wire, type Wired } from '@norbital-ai/std/wire';
import type { Json } from '../decl/values.ts';
import type { InputKind, ValueOf } from '../decl/fields.ts';
import type { ModelName, CustomFieldName, CustomShape, Row as RowOf } from '../decl/names.ts';
import { create_bolt, page_live_mode, type BoltConfig } from '../page/bolt.ts';
import { file_ref } from '../page/file-ref.ts';
import { toast } from '@norbital-ai/ui';
import { run } from '@norbital-ai/ui/effect';
import type { ShellMountConfig } from './mount.ts';
import { integration_clients, integration_offers } from '../page/integrations.ts';
import type { IntegrationSetupEntry } from '../page/integration.ts';
import { resolve_device, type DeviceApi } from '../page/device.ts';
import type { ActOutcome } from '../engine/contracts.ts';
import { BOLT, HEADERS, PATHS, RATE_LIMITED, uuidv7, type PushBody } from '../protocol/wire.ts';
import {
	AgentModels,
	InstanceMessage,
	InstanceSyncHealth,
	SyncReplayAnswer,
	SyncRetireAnswer,
	SyncDeadLetter,
	Invitation,
	LogRowAnswer,
	OlderPage,
	RunDetailAnswer,
	RunLogAnswer,
	RunsReadAnswer,
	RunViewAnswer,
	SettingsAnswer,
	ShellBootAnswer,
	ShellError,
	ShellWorkspace,
	SignInMethodsAnswer,
	StudioFileAnswer,
	StudioInspectionAnswer,
	StudioViewAnswer,
	Transcript,
	VerifiedAnswer,
	type ShellApi
} from './api-types.ts';
import { browserTransport } from '../protocol/client.ts';
import { ProtocolFailed, TransportFailed } from '../decl/errors.ts';
import { ActReply, WireError, type PageResult } from '../protocol/schema.ts';
import { AuditPage, AuditRecord } from '../protocol/audit.ts';
import { based, base, href, SHELL, VISITOR_APP, type ShellBoot } from './nav.ts';

const requestFailure = (status: number): ShellError =>
	new ShellError({
		status,
		code: status === 429 ? 'busy' : status >= 500 ? 'unavailable' : 'refused',
		message:
			status === 429
				? RATE_LIMITED
				: status === 503
					? 'The workspace is temporarily unavailable. Wait a moment and try again.'
					: status === 502 || status === 504
						? 'The workspace server did not respond in time. Try again shortly.'
						: status >= 500
							? 'The workspace server could not complete the request. Try again shortly.'
							: status === 403
								? 'You do not have permission to open this workspace.'
								: status === 404
									? 'The requested workspace or page could not be found.'
									: status === 410
										? 'This link has expired. Choose your workspace and sign in again.'
										: 'The server refused the request.'
	});

/** Every shell operation returns its value or fails with the route's typed refusal. */
export function shell_api(
	f: typeof fetch = (input, init) => fetch(input, init),
	options: {
		readonly base?: string;
		/** Refresh the owning snapshot client after a successful native mutation. */
		readonly after_mutation?: () => Effect.Effect<void, { readonly message: string }>;
	} = {}
): ShellApi {
	let contract: string | undefined;
	const instances = integration_clients({ base: based(`${BOLT}/integrations/`), fetch: f });
	const transport = browserTransport({ ...options, fetch: f });
	const transportError = (error: ProtocolFailed | TransportFailed) =>
		error instanceof TransportFailed && error.status === 0
			? new ShellError({
					code: 'offline',
					message: 'The workspace could not be reached.',
					status: 0
				})
			: new ShellError({
					code: 'protocol',
					message: 'The server returned an unexpected response. Reload the page and try again.',
					status: error instanceof TransportFailed ? error.status : 200
				});
	const failureSchema = Schema.Struct({
		error: Schema.Struct({
			code: Schema.String,
			message: Schema.String,
			workspace: Schema.optionalKey(ShellWorkspace)
		})
	});
	const wireError = (body: Json, status: number): ShellError => {
		const refused = Schema.decodeUnknownOption(failureSchema)(body);
		return Option.isNone(refused) || (status >= 500 && refused.value.error.code === 'internal')
			? requestFailure(status)
			: refused.value.error.code === 'rate_limited'
				? new ShellError({ code: 'rate_limited', message: RATE_LIMITED, status })
				: new ShellError({ ...refused.value.error, status });
	};
	/** A route's `{ value }` (`null` on a 204), decoded once by its answer's Schema. */
	const call = <A>(
		schema: Schema.Decoder<A>,
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: Json
	): Effect.Effect<A, ShellError> =>
		transport.request(method, based(path), body).pipe(
			Effect.mapError(transportError),
			Effect.flatMap((response) => {
				if (response.status >= 400) return Effect.fail(wireError(response.body, response.status));
				return (
					response.status === 204
						? Schema.decodeUnknownEffect(schema)(null)
						: Schema.decodeUnknownEffect(Schema.Struct({ value: schema }))(response.body).pipe(
								Effect.map((answer) => answer.value)
							)
				).pipe(
					Effect.mapError(
						() =>
							new ShellError({
								code: 'protocol',
								message:
									'The server returned an unexpected response. Reload the page and try again.',
								status: response.status
							})
					)
				);
			})
		);
	/** A route that answers nothing the caller reads. */
	const done = (method: 'POST', path: string, body?: Json) =>
		call(Schema.Unknown, method, path, body).pipe(Effect.asVoid);
	const q = (k: string, v: string) => `?${new URLSearchParams({ [k]: v })}`;
	const act = (callable: string, input: Json): Effect.Effect<ActOutcome, ShellError> =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const response = yield* transport
				.request(
					'POST',
					based(PATHS.act),
					{ callable, input, issued_at: new Date(now).toISOString() },
					{
						[HEADERS.key]: uuidv7(),
						...(contract === undefined ? {} : { [HEADERS.contract]: contract })
					}
				)
				.pipe(Effect.mapError(transportError));
			const refusal = Schema.decodeUnknownOption(WireError)(response.body);
			if (Option.isSome(refusal))
				return yield* Effect.fail(wireError(response.body, response.status));
			const reply = yield* Schema.decodeUnknownEffect(ActReply)(response.body).pipe(
				Effect.mapError(
					() =>
						new ShellError({
							code: 'protocol',
							message: 'The server returned an unexpected action response.',
							status: response.status
						})
				)
			);
			// A failed refresh is already delivered to readers; the acknowledged mutation must remain successful.
			if ((reply.outcome.kind === 'committed' || reply.outcome.kind === 'pending_approval' || reply.outcome.kind === 'running') && options.after_mutation !== undefined)
				yield* options.after_mutation().pipe(Effect.ignore);
			return reply.outcome;
		});
	return {
		boot: (app?: string, kiosk?: string) =>
			call(
				ShellBootAnswer,
				'GET',
				app === undefined && kiosk === undefined
					? SHELL
					: `${SHELL}?${new URLSearchParams({ ...(app === undefined ? {} : { app }), ...(kiosk === undefined ? {} : { kiosk }) })}`
			).pipe(
				Effect.tap((boot) =>
					Effect.sync(() => {
						contract = boot.contract;
					})
				)
			),
		methods: () => call(SignInMethodsAnswer, 'GET', PATHS.session.methods),
		send_code: (address: string, via: 'sms' | 'whatsapp' = 'sms') =>
			done('POST', PATHS.session.code, { address, via }),
		verify: (address: string, code: string) =>
			call(VerifiedAnswer, 'POST', PATHS.session.verify, { address, code }),
		sign_out: () => done('POST', PATHS.session.signout),
		invitation: (id: string) =>
			call(Invitation, 'GET', `${PATHS.session.invitation}/${encodeURIComponent(id)}`),
		accept: (id: string) => done('POST', PATHS.session.invitation, { id }),
		mark_notices_read: (ids: readonly string[]) =>
			act('sys_notification.mark_read', { ids: [...ids] }), // L-BOLT-354
		mark_all_notices_read: () => act('sys_notification.mark_read', { all: true }),
		runs: (o: { automation?: string; limit?: number } = {}) =>
			call(
				Schema.Array(RunViewAnswer),
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
		run: (id: string) => call(RunDetailAnswer, 'GET', `${SHELL}/runs${q('id', id)}`),
		run_log: (id: string, access: string, after?: string) => call(RunLogAnswer, 'GET', `${SHELL}/runs/log?${new URLSearchParams({ id, access, ...(after === undefined ? {} : { after }) })}`),
		stop_run: (id: string) => call(RunViewAnswer, 'POST', `${SHELL}/runs/stop`, { id }), // hook:runtime
		settings: () => call(SettingsAnswer, 'GET', `${SHELL}/settings`),
		settings_op: (op: string, input: Json) =>
			call(Schema.Json, 'POST', `${SHELL}/settings`, { op, input }),
		/** An integration instance's host verbs (`/__bolt/integrations/<instance>/…`); the host authorizes "may update this row". */
		integration: instances,
		integration_offers: () => integration_offers({ base: based(`${BOLT}/integrations/`), fetch: f }),
		/** L-COL-199: the workspace's logo (`null`, an `https:` URL or a `data:image/…` URL), an administrator's. */
		organization: (logo: string | null) => done('POST', `${SHELL}/organization`, { logo }),
		/** An instance's raw messages, both directions, newest first (an administrator's; the instance's Messages tab). */
		instance_messages: (instance: string, before?: string) =>
			call(
				Schema.Array(InstanceMessage),
				'GET',
				`${SHELL}/instance-messages?${new URLSearchParams(
					before === undefined ? { instance } : { instance, before }
				)}`
			),
		instance_sync_health: (instance: string) =>
			call(
				InstanceSyncHealth,
				'GET',
				`${SHELL}/instance-sync-health?${new URLSearchParams({ instance })}`
			),
		replay_instance_sync: (instance: string, ids?: readonly string[]) =>
			call(SyncReplayAnswer, 'POST', `${SHELL}/instance-sync-replay`, {
				instance,
				...(ids === undefined ? {} : { ids: [...ids] })
			}),
		instance_sync_dead_letters: (instance: string) =>
			call(
				Schema.Array(SyncDeadLetter),
				'GET',
				`${SHELL}/instance-sync-dead-letters?${new URLSearchParams({ instance })}`
			),
		retire_instance_sync: (instance: string, id: string) =>
			call(SyncRetireAnswer, 'POST', `${SHELL}/instance-sync-retire`, { instance, id }),
		logs: (x: import('../engine/contracts.ts').LogQuery) =>
			call(
				Schema.Array(LogRowAnswer),
				'GET',
				`${SHELL}/logs?${new URLSearchParams(
					Object.entries({
						before: x.before,
						after: x.after,
						level: x.level,
						q: x.text,
						conversation: x.conversation,
						run: x.run,
						automation: x.automation,
						since: x.since,
						until: x.until
					}).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '')
				)}`
			),
		audit: (query) => call(AuditPage, 'POST', `${SHELL}/audit/query`, encode_wire(query)),
		audit_detail: (id) =>
			call(Schema.NullOr(AuditRecord), 'GET', `${SHELL}/audit/detail${q('id', id)}`),
		studio: () => call(StudioViewAnswer, 'GET', `${SHELL}/studio`),
		studio_run: (op: import('./studio/model.ts').StudioOp) =>
			call(StudioViewAnswer, 'POST', `${SHELL}/studio`, { op }),
		studio_file: (commit: string, path: string) =>
			call(
				StudioFileAnswer,
				'GET',
				`${SHELL}/studio/file?${new URLSearchParams({ commit, path })}`
			),
		studio_inspect: (input) =>
			call(
				StudioInspectionAnswer,
				'GET',
				`${SHELL}/studio/inspect?${new URLSearchParams(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`
			),
		/** Rule 39: a member id, `{ team }`, or `null` to end the preview. */
		preview: (target: string | { team: string } | null) =>
			done(
				'POST',
				`${SHELL}/preview`,
				typeof target === 'object' && target !== null ? target : { user: target }
			),
		/** `access.explain` (L-BOLT-234): the caller's own Authority, or (administrators) a member's or team's. */
		explain: (target?: { user: string } | { team: string }) =>
			call(
				Schema.Json,
				'GET',
				`${SHELL}/explain${target === undefined ? '' : `?${new URLSearchParams(target)}`}`
			),
		push: (body: PushBody) => done('POST', PATHS.push, body),
		agent: {
			start: (title?: string, model?: string) =>
				act('sys_conversation.start', {
					...(title === undefined ? {} : { title }),
					...(model === undefined ? {} : { model })
				}),
			/** The models the member may pick and the one a new conversation runs, and the MCP servers its policies name (their conversations are the live `conversations` read). */
			models: () => call(AgentModels, 'GET', `${PATHS.agent}/models`),
			/** `mode`: the composer's `/plan` or `/compact` (§5.9). */
			post: (
				conversation: string,
				text: string,
				now?: boolean,
				attachments: readonly { readonly id: string }[] = [],
				mode?: 'plan' | 'compact',
				schedule?: string,
				question?: string
			) =>
				act('sys_message.post', {
					conversation,
					text,
					...(question === undefined ? {} : { question }),
					...(now === true ? { now } : {}),
					...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
					...(mode === undefined ? {} : { mode }),
					...(schedule === undefined ? {} : { schedule })
				}),
			page_result: (message: string, result: PageResult) =>
				act('sys_message.page_result', { message, result }),
			claim_page_action: (message: string) => act('sys_message.claim_page_action', { message }),
			/** hook:attachments — one panel attachment to `/__bolt/files/sys_conversation.inputs`: its `FileRef`, or the refusal. */
			upload: (file: File) =>
				transport
					.upload(based(`${PATHS.files}sys_conversation.inputs`), file, {
						[HEADERS.key]: uuidv7(),
						'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
					})
					.pipe(
						Effect.mapError(transportError),
						Effect.flatMap((response) => {
							const refusal = Schema.decodeUnknownOption(WireError)(response.body);
							if (Option.isSome(refusal))
								return Effect.fail(wireError(response.body, response.status));
							return Schema.decodeUnknownEffect(
								Schema.Struct({
									id: Schema.String,
									name: Schema.String,
									mime: Schema.String,
									bytes: Schema.Number
								})
							)(response.body).pipe(
								Effect.map((file) => ({ ...file, id: file_ref(file).id })),
								Effect.mapError(
									() =>
										new ShellError({
											code: 'protocol',
											message: 'The host returned an invalid attachment.',
											status: response.status
										})
								)
							);
						})
					),
			respond_now: (conversation: string) => act('sys_conversation.respond_now', { conversation }), // hook:triage
			confirm: (message: string, approve: boolean) =>
				act('sys_message.confirm', { message, approve }),
			// hook:agent-ui — §5.9's remaining generated actions
			set_agent: (conversation: string, agent: string) =>
				act('sys_conversation.set_agent', { conversation, agent }),
			file: (message: string, about: { model: string; id: string } | null) =>
				act('sys_message.file', { message, about }),
			stop: (conversation: string) => act('sys_conversation.stop', { conversation }),
			set_model: (conversation: string, model: string) =>
				act('sys_conversation.set_model', { conversation, model }),
			revise: (message: string, text: string, attachments?: readonly Json[]) => act('sys_message.revise', { message, text, ...(attachments === undefined ? {} : { attachments }) }),
			restart: (message: string) => act('sys_message.restart', { message }),
			dequeue: (message: string) => act('sys_message.dequeue', { message }),
			reorder: (conversation: string, messages: readonly string[]) =>
				act('sys_message.reorder', { conversation, messages: [...messages] }),
			execute_plan: (conversation: string) => act('sys_message.execute_plan', { conversation }),
			discard_plan: (conversation: string) => act('sys_message.discard_plan', { conversation }),
			resume: (conversation: string) => act('sys_conversation.resume', { conversation }),
			transcript: (conversation: string) =>
				call(Transcript, 'GET', `${PATHS.agent}${q('conversation', conversation)}`),
			/** The `limit` messages just before `seq` `before` (the panel's older page); `more`: another may lie before `first`. */
			older: (conversation: string, before: number, limit: number) =>
				call(
					OlderPage,
					'GET',
					`${PATHS.agent}?${new URLSearchParams({ conversation, before: String(before), limit: String(limit) })}`
				)
		}
	};
}

/**
 * Turnstile tokens are single-use (GAPS r5 11): a request that needs one waits for the next token, spends it and
 * asks the widget for another. `put` is the widget's callback; `reset` re-arms the widget.
 */
export const challenge_queue = (reset: () => void = () => {}) =>
	Effect.gen(function* () {
		const tokens = yield* Queue.unbounded<string>();
		return {
			put: (token: string) => {
				Queue.offerUnsafe(tokens, token);
			},
			take: Queue.take(tokens).pipe(Effect.tap(() => Effect.sync(() => reset()))),
			setReset: (fn: () => void) => {
				reset = fn;
			}
		};
	});
export type ChallengeQueue = Effect.Success<ReturnType<typeof challenge_queue>>;

/** A kiosk page's fetch: every `/__bolt` request names the kiosk, whose assigned policies it runs as. */
export function kiosk_fetch(
	kiosk: () => string | null,
	f: typeof fetch = (i, o) => fetch(i, o)
): typeof fetch {
	return async (input, init = {}) => {
		const k = kiosk();
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const path = new URL(url, 'http://x').pathname.slice(base().length);
		if (k === null || !path.startsWith(`${BOLT}/`)) return f(input, init);
		const headers = new Headers(init.headers);
		headers.set(HEADERS.kiosk, k);
		return f(input, { ...init, headers });
	};
}

/** A visitor page's fetch: every `/__bolt` request names the app; an upload and a final act carry a fresh token. */
export function visitor_fetch(
	app: string,
	challenge: ChallengeQueue | null,
	f: typeof fetch = (i, o) => fetch(i, o)
): typeof fetch {
	return async (input, init = {}) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const path = new URL(url, 'http://x').pathname.slice(base().length);
		if (!path.startsWith(`${BOLT}/`)) return f(input, init);
		const headers = new Headers(init.headers);
		headers.set(VISITOR_APP, app);
		const method = (init.method ?? 'GET').toUpperCase();
		if (
			challenge !== null &&
			((method === 'POST' && (path === PATHS.act || path === PATHS.session.code)) ||
				(method === 'PUT' && path.startsWith(PATHS.files)))
		)
			headers.set(HEADERS.challenge, await run(challenge.take));
		return f(input, { ...init, headers });
	};
}

/** `conversation`: the one to open (`null` a new one; absent: the one this tab last had), as `?agent=` names it. */
export type AgentRequest = {
	prompt?: string;
	/** Sends `prompt` as soon as the panel has it, once for each value: a button asking on the person's behalf. */
	send?: string;
	about?: { model: string; id: string };
	conversation?: string | null;
};
/** The agent panel's open state; the shell renders the panel, the agent area its conversation. */
export function agent_panel() {
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
type RowFor<C> = C extends ModelName ? RowOf<C> : Row;
/** X-20: what `+representation.svelte` receives, `{ view: RecordView<'<model>'> }` (ui's views pass the same shape). */
export type RecordView<C extends string = string> =
	| { model: C; mode: 'update'; record: RowFor<C> }
	| { model: C; mode: 'create'; values: Partial<RowFor<C>> };
type CustomValue<F> = F extends CustomFieldName
	? ValueOf<CustomShape<F>>
	: import('@norbital-ai/std/kind').Value;
type ViewCommon<F> = {
	name: F;
	value: CustomValue<F> | null;
	row?: { readonly [field: string]: import('@norbital-ai/std/kind').Value };
	kind?: F extends CustomFieldName ? CustomShape<F> : InputKind;
	id?: string;
	address?: { value: string | null; on_change?(next: string | null): void };
};
/**
 * §3.2 role 5: what `+renderer.svelte` receives, `{ view: CustomFieldView<'<f>'> }`, a workspace's and a built-in's
 * (`money`, `file`, `point`, `phone`) alike. `row` is the record's other field values (the form's draft in edit mode),
 * absent when a page embeds the renderer; `kind` the field's literal (a custom reference's shape); `dense` asks for one
 * compact line (a table cell, a card); `address` is a `point` field's address sibling.
 */
export type CustomFieldView<F extends string = string> =
	| (ViewCommon<F> & { mode: 'show'; dense?: true })
	| (ViewCommon<F> & {
			mode: 'edit';
			disabled: boolean;
			error?: string;
			on_change(next: CustomValue<F> | null): void;
	  });

/** The page context (§3.5): the data client plus `href` and `agent`; a visitor page's client names its app on every request. */
export function shell_bolt(
	boot: ShellBoot,
	options: {
		messages?: BoltConfig['messages'];
		integration_setups?: { readonly [integration: string]: IntegrationSetupEntry };
		challenge?: ChallengeQueue;
		agent?: ReturnType<typeof agent_panel>;
		fetch?: typeof fetch;
		open_stream?: BoltConfig['open_stream'];
		models?: () => readonly string[];
		device?: DeviceApi;
		/** A kiosk page's client names its kiosk on every request (header) and stream (query). */
		kiosk?: () => string | null;
	} = {}
) {
	return Effect.gen(function* () {
		const visitor = boot.visitor;
		const scoped =
			options.kiosk === undefined ? options.fetch : kiosk_fetch(options.kiosk, options.fetch);
		// a member page's stream is shared with the browser's other tabs (create_bolt's default); a kiosk or visitor page,
		// whose stream answers another audience, opens its own (a kiosk boots again when it changes)
		const own = (u: string) =>
			options.open_stream?.(u) ?? new EventSource(u, { withCredentials: true });
		const kiosk = options.kiosk?.() ?? null;
		const open_stream =
			kiosk !== null
				? (url: string) =>
						own(`${url}${url.includes('?') ? '&' : '?'}kiosk=${encodeURIComponent(kiosk)}`)
				: visitor !== null
					? own
					: options.open_stream;
		const f =
			visitor === null
				? scoped
				: visitor_fetch(
						visitor.app,
						visitor.site_key === undefined ? null : (options.challenge ?? null),
						scoped
					);
		const client = yield* create_bolt({
			on_notice: (notice) => {
				if (typeof notice['title'] === 'string')
					toast.info(
						notice['title'],
						typeof notice['body'] === 'string' ? { description: notice['body'] } : undefined
					);
			},
			base: base(),
			actor: boot.actor,
			locale: boot.workspace.locale,
			tz: boot.workspace.tz,
			catalog: boot.catalog,
			read_catalog: boot.read_catalog,
			operation_outputs: boot.operation_outputs,
			/* hook:query (bolt.decode) */ describe:
				boot.visitor === null && boot.ai_unconfigured !== true,
			/* hook:decisions (rule 16a) */ ...(options.messages === undefined
				? {}
				: { messages: options.messages }),
			...(f === undefined ? {} : { fetch: f }),
			...(open_stream === undefined ? {} : { open_stream }),
			...(boot.contract === undefined ? {} : { contract: boot.contract })
		});
		const agent = options.agent ?? agent_panel();
		const api = shell_api(options.fetch, {
			after_mutation: () => page_live_mode() === 'snapshot' ? client.refresh() : Effect.void
		});
		const instances = integration_clients({
			base: based(`${BOLT}/integrations/`),
			...(f === undefined ? {} : { fetch: f })
		});
		return Object.assign(client, {
			device: resolve_device(options.device),
			/** An integration instance's host verbs: its status, pairing, test and status stream (`IntegrationSetup` draws them). */
			integration: instances,
			/** Provider choices for the shared IntegrationCard, using this workspace's authenticated transport. */
			integration_offers: () => integration_offers({ base: based(`${BOLT}/integrations/`), ...(f === undefined ? {} : { fetch: f }) }),
			/** A definition's own setup component (`integration/<name>/+integration.svelte`), loaded only when its UI opens. */
			integration_setup: (name: string) => options.integration_setups?.[name]?.load,
			/** The path of an app page, optionally opening a record: `bolt.href(app, page?, record?)`. */
			href: (...a: Parameters<typeof href>) => based(href(...a)),
			/** The page's organization: the workspace name and its brand logo (the host's first icon), or `null`. */
			org: { name: boot.workspace.name, logo: boot.workspace.logo ?? null },
			tz: boot.workspace.tz,
			catalog: boot.catalog,
			automations: boot.automations,
			runs: Object.assign(
				(automation: string, options: { where?: Json; limit: number }) =>
					Effect.gen(function* () {
						const conditions = yield* Schema.decodeUnknownEffect(
							Schema.Record(Schema.String, Schema.Struct({ eq: Schema.Json }))
						)(options.where ?? {}).pipe(
							Effect.mapError(
								() =>
									new ShellError({
										code: 'invalid',
										message: 'runs: where takes { <field>: { eq } } conditions.',
										status: 400
									})
							)
						);
						// one run by id is read as itself: the latest `limit` runs need not hold an earlier run (RunStatus)
						const one = conditions['id']?.eq;
						// the live `runs` read: a `sys_run` change re-answers it, as the caller may see it (rule 56)
						return client
							.observe({
								read: {
									m: 'runs',
									a: [
										typeof one === 'string'
											? { automation, id: one, limit: 1 }
											: { automation, limit: options.limit }
									]
								}
							}, RunsReadAnswer)
							.pipe(
								Stream.map((answer) => ({
									rows: answer.rows.filter((row) => {
										const values: Readonly<Record<string, Wired>> = row;
										return Object.entries(conditions).every(([field, condition]) =>
											Equal.equals(encode_wire(values[field] ?? null), encode_wire(condition.eq))
										);
									}),
									next: null
								}))
							);
					}).pipe(Stream.unwrap),
				{ stop: (id: string) => api.stop_run(id) }
			),
			/** The agent panel: `open` it (optionally with a request), and the model classes the host offers. */
			agent: {
				open: (request: AgentRequest = {}) => {
					if (boot.surfaces.agent) agent.open(request);
				},
				models: () => options.models?.() ?? []
			}
		});
	});
}
export type ShellBolt = Effect.Success<ReturnType<typeof shell_bolt>>;
/** What a mounted page receives: the shell client without its native transport members. */
export type ShellPageContext = Omit<ShellBolt, 'native_query' | 'observe' | 'closed' | 'sync'>;

/** Each shell mount owns its configured runtime and every child resource. */
class ShellConfiguration extends Context.Service<ShellConfiguration, ShellMountConfig>()(
	'@norbital-ai/bolt/ShellConfiguration'
) {}
export const ShellLive = (config: ShellMountConfig) => Layer.succeed(ShellConfiguration, config);
