// The shell's browser half (§3.5, §5.10): `$bolt` as pages see it (the data client plus `href` and `agent`), the
// shell's own routes, and the visitor fetch that names the page's app and spends one Turnstile token per request that
// needs one. The generated `$bolt` module re-exports `bolt` (below) with the ui edge (`run`, `fork`, `attach`).
import {
	Clock,
	Context,
	Effect,
	Equal,
	Layer,
	Option,
	Queue,
	Schema,
	Schedule,
	Stream
} from 'effect';
import { encodeWire, type Wired } from '@norbital-ai/std/wire';
import type { Json } from '../decl/values.ts';
import type { InputKind, ValueOf } from '../decl/fields.ts';
import type { ModelName, CustomFieldName, CustomShape, Row as RowOf } from '../decl/names.ts';
import { createBolt, type BoltConfig } from '../page/bolt.ts';
import { fileRef } from '../page/file-ref.ts';
import { toast } from '@norbital-ai/ui';
import { run } from '@norbital-ai/ui/effect';
import type { ShellMountConfig } from './mount.ts';
import { integrationClients, integrationOffers } from '../page/integrations.ts';
import type { IntegrationSetupEntry } from '../page/integration.ts';
import { resolveDevice, type DeviceApi } from '../page/device.ts';
import type { ActOutcome } from '../engine/contracts.ts';
import { BOLT, HEADERS, PATHS, uuidv7, type PushBody } from '../protocol/wire.ts';
import {
	AgentModels,
	InboxAnswer,
	InstanceMessage,
	InstanceSyncHealth,
	SyncReplayAnswer,
	Invitation,
	LogRowAnswer,
	OlderPage,
	RunDetailAnswer,
	RunViewAnswer,
	SettingsAnswer,
	ShellBootAnswer,
	ShellError,
	ShellWorkspace,
	SignInMethodsAnswer,
	StudioAuditAnswer,
	StudioAuditRulesAnswer,
	StudioBuildAnswer,
	StudioFileAnswer,
	StudioUsageAnswer,
	StudioInspectionAnswer,
	StudioViewAnswer,
	Transcript,
	VerifiedAnswer,
	type ShellApi
} from './api-types.ts';
import { browserTransport } from '../protocol/client.ts';
import { ProtocolFailed, TransportFailed } from '../decl/errors.ts';
import { ActReply, WireError } from '../protocol/schema.ts';
import { AuditPage, AuditRecord } from '../protocol/audit.ts';
import { based, BASE, href, SHELL, VISITOR_APP, type ShellBoot } from './nav.ts';

const requestFailure = (status: number): ShellError =>
	new ShellError({
		status,
		code: status === 429 ? 'busy' : status >= 500 ? 'unavailable' : 'refused',
		message:
			status === 429
				? 'Too many requests. Wait a moment and try again.'
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
export function shellApi(
	f: typeof fetch = (input, init) => fetch(input, init),
	options: { readonly base?: string } = {}
): ShellApi {
	let contract: string | undefined;
	const instances = integrationClients({ base: based(`${BOLT}/integrations/`), fetch: f });
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
					{ callable, input, issuedAt: new Date(now).toISOString() },
					{
						[HEADERS.key]: uuidv7(),
						...(contract === undefined ? {} : { [HEADERS.contract]: contract })
					}
				)
				.pipe(Effect.mapError(transportError));
			const refusal = Schema.decodeUnknownOption(WireError)(response.body);
			if (Option.isSome(refusal))
				return yield* Effect.fail(wireError(response.body, response.status));
			return (yield* Schema.decodeUnknownEffect(ActReply)(response.body).pipe(
				Effect.mapError(
					() =>
						new ShellError({
							code: 'protocol',
							message: 'The server returned an unexpected action response.',
							status: response.status
						})
				)
			)).outcome;
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
		sendCode: (address: string, via: 'sms' | 'whatsapp' = 'sms') =>
			done('POST', PATHS.session.code, { address, via }),
		verify: (address: string, code: string) =>
			call(VerifiedAnswer, 'POST', PATHS.session.verify, { address, code }),
		signOut: () => done('POST', PATHS.session.signout),
		invitation: (id: string) =>
			call(Invitation, 'GET', `${PATHS.session.invitation}/${encodeURIComponent(id)}`),
		accept: (id: string) => done('POST', PATHS.session.invitation, { id }),
		inbox: () => call(InboxAnswer, 'GET', `${SHELL}/inbox`),
		markNoticesRead: (ids: readonly string[]) =>
			act('sys_notification.markRead', { ids: [...ids] }), // L-BOLT-354
		markAllNoticesRead: () => act('sys_notification.markRead', { all: true }),
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
		stopRun: (id: string) => call(RunViewAnswer, 'POST', `${SHELL}/runs/stop`, { id }), // hook:runtime
		settings: () => call(SettingsAnswer, 'GET', `${SHELL}/settings`),
		settingsOp: (op: string, input: Json) =>
			call(Schema.Json, 'POST', `${SHELL}/settings`, { op, input }),
		/** An integration instance's host verbs (`/__bolt/integrations/<instance>/…`); the host authorizes "may update this row". */
		integration: instances,
		integrationOffers: () => integrationOffers({ base: based(`${BOLT}/integrations/`), fetch: f }),
		/** L-COL-199: the workspace's name and logo (`null`, an `https:` URL or a `data:image/…` URL), an administrator's. */
		organization: (name: string, logo: string | null) =>
			done('POST', `${SHELL}/organization`, { name, logo }),
		/** An instance's raw messages, both directions, newest first (an administrator's; the instance's Messages tab). */
		instanceMessages: (instance: string, before?: string) =>
			call(
				Schema.Array(InstanceMessage),
				'GET',
				`${SHELL}/instance-messages?${new URLSearchParams(
					before === undefined ? { instance } : { instance, before }
				)}`
			),
		instanceSyncHealth: (instance: string) =>
			call(
				InstanceSyncHealth,
				'GET',
				`${SHELL}/instance-sync-health?${new URLSearchParams({ instance })}`
			),
		replayInstanceSync: (instance: string, ids?: readonly string[]) =>
			call(SyncReplayAnswer, 'POST', `${SHELL}/instance-sync-replay`, {
				instance,
				...(ids === undefined ? {} : { ids: [...ids] })
			}),
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
		audit: (query) => call(AuditPage, 'POST', `${SHELL}/audit/query`, encodeWire(query)),
		auditDetail: (id) =>
			call(Schema.NullOr(AuditRecord), 'GET', `${SHELL}/audit/detail${q('id', id)}`),
		studio: () => call(StudioViewAnswer, 'GET', `${SHELL}/studio`),
		studioRun: (op: import('./studio/model.ts').StudioOp) =>
			call(StudioViewAnswer, 'POST', `${SHELL}/studio`, { op }),
		studioFile: (commit: string, path: string) =>
			call(
				StudioFileAnswer,
				'GET',
				`${SHELL}/studio/file?${new URLSearchParams({ commit, path })}`
			),
		studioBuild: (commit: string) =>
			call(StudioBuildAnswer, 'GET', `${SHELL}/studio/build?${new URLSearchParams({ commit })}`),
		studioUsage: () => call(StudioUsageAnswer, 'GET', `${SHELL}/studio/usage`),
		studioInspect: (input) =>
			call(
				StudioInspectionAnswer,
				'GET',
				`${SHELL}/studio/inspect?${new URLSearchParams(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`
			),
		studioAuditRules: () => call(StudioAuditRulesAnswer, 'GET', `${SHELL}/studio/audit`),
		studioAuditSave: (revision: number, ruleSet: import('./studio/audit.ts').AuditRuleSet) =>
			call(StudioAuditRulesAnswer, 'POST', `${SHELL}/studio/audit`, { revision, ruleSet }),
		studioAudit: (ruleSet?: import('./studio/audit.ts').AuditRuleSet) =>
			call(
				StudioAuditAnswer,
				'POST',
				`${SHELL}/studio/audit/run`,
				ruleSet === undefined ? {} : { ruleSet }
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
				attachments: readonly import('../decl/runtime/integration.ts').Attachment[] = [],
				mode?: 'plan' | 'compact'
			) =>
				act('sys_message.post', {
					conversation,
					text,
					...(now === true ? { now } : {}),
					...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
					...(mode === undefined ? {} : { mode })
				}),
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
								Effect.map((file) => ({ ...file, id: fileRef(file).id })),
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
			respondNow: (conversation: string) => act('sys_conversation.respondNow', { conversation }), // hook:triage
			confirm: (message: string, approve: boolean) =>
				act('sys_message.confirm', { message, approve }),
			// hook:agent-ui — §5.9's remaining generated actions
			setAgent: (conversation: string, agent: string) =>
				act('sys_conversation.setAgent', { conversation, agent }),
			file: (message: string, about: { model: string; id: string } | null) =>
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
export const challengeQueue = (reset: () => void = () => {}) =>
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
export type ChallengeQueue = Effect.Success<ReturnType<typeof challengeQueue>>;

/** A kiosk page's fetch: every `/__bolt` request names the kiosk, whose assigned policies it runs as. */
export function kioskFetch(
	kiosk: () => string | null,
	f: typeof fetch = (i, o) => fetch(i, o)
): typeof fetch {
	return async (input, init = {}) => {
		const k = kiosk();
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const path = new URL(url, 'http://x').pathname.slice(BASE.length);
		if (k === null || !path.startsWith(`${BOLT}/`)) return f(input, init);
		const headers = new Headers(init.headers);
		headers.set(HEADERS.kiosk, k);
		return f(input, { ...init, headers });
	};
}

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
			headers.set(HEADERS.challenge, await run(challenge.take));
		return f(input, { ...init, headers });
	};
}

/** `conversation`: the one to open (`null` a new one; absent: the one this tab last had), as `?agent=` names it. */
export type AgentRequest = {
	prompt?: string;
	about?: { model: string; id: string };
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
	address?: { value: string | null; onChange?(next: string | null): void };
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
			onChange(next: CustomValue<F> | null): void;
	  });

/**
 * An engine whose responses never stream (an agent's light browser) installs `window.boltLivePoll`, milliseconds: its
 * current reads are read again on that interval instead of streamed, or no live read would ever show.
 */
const livePoll = () => {
	if (typeof window === 'undefined') return undefined;
	const descriptor: TypedPropertyDescriptor<unknown> | undefined = Object.getOwnPropertyDescriptor(
		window,
		'boltLivePoll'
	);
	const value = descriptor?.value;
	return typeof value === 'number' && value > 0 ? (`${value} millis` as const) : undefined;
};

/** `$bolt` (§3.5): the data client plus `href` and `agent`; a visitor page's client names its app on every request. */
export function shellBolt(
	boot: ShellBoot,
	options: {
		messages?: BoltConfig['messages'];
		integrationSetups?: { readonly [integration: string]: IntegrationSetupEntry };
		challenge?: ChallengeQueue;
		agent?: ReturnType<typeof agentPanel>;
		fetch?: typeof fetch;
		openStream?: BoltConfig['openStream'];
		models?: () => readonly string[];
		device?: DeviceApi;
		/** A kiosk page's client names its kiosk on every request (header) and stream (query). */
		kiosk?: () => string | null;
	} = {}
) {
	return Effect.gen(function* () {
		const visitor = boot.visitor;
		const scoped =
			options.kiosk === undefined ? options.fetch : kioskFetch(options.kiosk, options.fetch);
		const openStream =
			options.kiosk === undefined
				? options.openStream
				: (url: string) => {
						const k = options.kiosk?.() ?? null;
						const u =
							k === null
								? url
								: `${url}${url.includes('?') ? '&' : '?'}kiosk=${encodeURIComponent(k)}`;
						return options.openStream?.(u) ?? new EventSource(u, { withCredentials: true });
					};
		const f =
			visitor === null
				? scoped
				: visitorFetch(
						visitor.app,
						visitor.siteKey === undefined ? null : (options.challenge ?? null),
						scoped
					);
		const poll = livePoll();
		const client = yield* createBolt({
			onNotice: (notice) => {
				if (typeof notice['title'] === 'string')
					toast.info(
						notice['title'],
						typeof notice['body'] === 'string' ? { description: notice['body'] } : undefined
					);
			},
			base: BASE,
			actor: boot.actor,
			locale: boot.workspace.locale,
			tz: boot.workspace.tz,
			catalog: boot.catalog,
			/* hook:query (bolt.decode) */ describe:
				boot.visitor === null && boot.aiUnconfigured !== true,
			/* hook:decisions (rule 16a) */ ...(options.messages === undefined
				? {}
				: { messages: options.messages }),
			...(f === undefined ? {} : { fetch: f }),
			...(openStream === undefined ? {} : { openStream }),
			...(poll === undefined ? {} : { poll }),
			...(boot.contract === undefined ? {} : { contract: boot.contract })
		});
		const agent = options.agent ?? agentPanel();
		const api = shellApi(options.fetch);
		const instances = integrationClients({
			base: based(`${BOLT}/integrations/`),
			...(f === undefined ? {} : { fetch: f })
		});
		return Object.assign(client, {
			device: resolveDevice(options.device),
			/** An integration instance's host verbs: its status, pairing, test and status stream (`IntegrationSetup` draws them). */
			integration: instances,
			/** A definition's own setup component (`integration/<name>/+integration.svelte`), loaded only when its UI opens. */
			integrationSetup: (name: string) => options.integrationSetups?.[name]?.load,
			/** The path of an app page, optionally opening a record: `bolt.href(app, page?, record?)`. */
			href: (...a: Parameters<typeof href>) => based(href(...a)),
			/** The page's organization: the workspace name and its brand logo (the host's first icon), or `null`. */
			org: { name: boot.workspace.name, logo: boot.workspace.logo ?? null },
			runs: Object.assign(
				(automation: string, options: { where?: Json; limit: number }) =>
					Stream.fromEffectSchedule(
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
							const rows =
								typeof one === 'string'
									? yield* api.run(one).pipe(
											Effect.map((row) => [row]),
											Effect.catch((error) =>
												error.status === 404 || error.status === 403
													? Effect.succeed([])
													: Effect.fail(error)
											)
										)
									: yield* api.runs({ automation, limit: options.limit });
							return {
								rows: rows.filter((row) => {
									const values: Readonly<Record<string, Wired>> = row;
									return Object.entries(conditions).every(([field, condition]) =>
										Equal.equals(encodeWire(values[field] ?? null), encodeWire(condition.eq))
									);
								}),
								next: null
							};
						}),
						Schedule.spaced('2 seconds')
					),
				{ stop: (id: string) => api.stopRun(id) }
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
export type ShellBolt = Effect.Success<ReturnType<typeof shellBolt>>;

/** Each shell mount owns its configured runtime and every child resource. */
class ShellConfiguration extends Context.Service<ShellConfiguration, ShellMountConfig>()(
	'@norbital-ai/bolt/ShellConfiguration'
) {}
export const ShellLive = (config: ShellMountConfig) => Layer.succeed(ShellConfiguration, config);

let current: ShellBolt | null = null;
export const setCurrentBolt = (client: ShellBolt | null) => {
	current = client;
};
export function currentBolt(): ShellBolt {
	if (current === null) throw new Error('$bolt was read before the workspace shell booted.');
	return current;
}
/** Stable module value: calls and plain getters read the current boot on use. */
export const bolt: Omit<ShellBolt, 'describe'> & { readonly describe: ShellBolt['describe'] } = {
	get aggregate() {
		return currentBolt().aggregate;
	},
	get history() {
		return currentBolt().history;
	},
	get query() {
		return currentBolt().query;
	},
	act: (...args) => currentBolt().act(...args),
	recordCapabilities: (...args) => currentBolt().recordCapabilities(...args),
	decode: (...args) => currentBolt().decode(...args),
	get describe() {
		return currentBolt().describe;
	},
	options: (...args) => currentBolt().options(...args),
	start: (...args) => currentBolt().start(...args),
	clock: (...args) => currentBolt().clock(...args),
	convert: (...args) => currentBolt().convert(...args),
	observe: (...args) => currentBolt().observe(...args),
	upload: (...args) => currentBolt().upload(...args),
	fileUrl: (...args) => currentBolt().fileUrl(...args),
	get approvals() {
		return currentBolt().approvals;
	},
	get restore() {
		return currentBolt().restore;
	},
	get session() {
		return currentBolt().session;
	},
	get actor() {
		return currentBolt().actor;
	},
	get locale() {
		return currentBolt().locale;
	},
	t: (...args) => currentBolt().t(...args),
	get closed() {
		return currentBolt().closed;
	},
	get sync() {
		return currentBolt().sync;
	},
	get device() {
		return currentBolt().device;
	},
	integration: (...args) => currentBolt().integration(...args),
	integrationSetup: (...args) => currentBolt().integrationSetup(...args),
	href: (...args) => currentBolt().href(...args),
	get org() {
		return currentBolt().org;
	},
	get runs() {
		return currentBolt().runs;
	},
	get agent() {
		return currentBolt().agent;
	}
};
