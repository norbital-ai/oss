// Envoys (authority by P32). An envoy is a runtime `sys_envoy` row
// deployed on a workspace conversation instance (`sys_integration.envoy`, active, no owner); every turn runs as the
// `envoy` actor on that instance. The ingest statement queues one `envoys.admit` run per new live message there, so a
// crash between ingest and admission loses no turn. Admission reads the instance and the envoy's spec as they are now
// (fail closed on either) and decides the row once: email is always addressed, a group follows `group_messages` (the rest
// is ambient history `read_messages` reads), triage may hold it. The sender is matched to an active member by the handle
// the definition's conversation carries (`senders.ts`) under both audiences. A `private` envoy admits no unknown sender:
// it gets one fixed notice (`envoys.unrecognised`, default 1 per 15 minutes per sender) in their own DM, never into a
// group, and no turn; there is no registration, an administrator records the handle. Every limit is the envoy's own:
// `envoys.receive` per sender and per subject, `agent` desk-wide. An admitted row becomes the agent's queued input with its
// sender header (a steer: the running turn takes it at its next step); its turn holds the authority `identity/actor.ts`
// compiles — a group's the envoy's policies alone, a linked member's DM theirs joined (`dm: 'union'`) or bound (`'envoy'`).
import { sql } from '../db/sql.ts';
import { Clock, Context, Effect, FiberSet, Layer, Schema } from 'effect';
import { driver_name, type HandleKind } from '../../decl/runtime/integration.ts';
import type { Json } from '../../decl/values.ts';
import { charges_for, RateWindows } from '../access/rate.ts';
import { AGENT_LIMITS, AgentDrains, type As } from '../agent/index.ts';
import { TURN_RUN } from '../agent/turns.ts';
import { SmartThrottle, type Throttle } from '../agent/throttle.ts';
import type { ConversationsShape } from '../services.ts';
import { ADMIT, preview, msg as messagePiece } from '../conversations/store.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { AgentEngine } from '../agent/index.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { CapturedResult, nativeCommit } from '../db/captured.ts';
import {
	Envoys as EnvoysTag,
	Manifest,
	Live,
	Conversations as ConversationsTag,
	Outbound,
	RunHandlers,
	Wake
} from '../services.ts';
import type { EngineError } from '../errors.ts';
import { TurnHandlers } from '../agent/turns.ts';
import { Authorities } from '../identity/actor.ts';
import { conversationOf, definitionOf } from '../integrations/instances.ts';
import { envoySpec, type EnvoySpec } from './spec.ts';
import { DELIVER, EPOCH } from '../integrations/outbound.ts';
import { Chain } from '../write/sql.ts';
import { enqueue, next_due } from '../runs/queue.ts';
import { canonicalHandle, memberByHandle } from './senders.ts';
import { Logs } from '../ports.ts';
export type EnvoysConfig = {
	engine: Pick<AgentEngine, 'manifest' | 'db' | 'live'>;
	conversations: Pick<ConversationsShape, 'send'>;
	/** The outbound area's delivery (`integrations.deliver`): shipped replies leave at once. */
	deliver: Effect.Effect<unknown, EngineError>;
	agents: AgentDrains['Service'];
	authorities?: Authorities;
	clock?: Effect.Effect<string>;
	announce: (at: string) => Effect.Effect<void>;
	/** The name a notice uses for this workspace. */
	workspace?: string;
	/** Rule 60a: System 1 triage, when the host binds its port. */
	triage?: Pick<Throttle, 'envoy' | 'hold' | 'release'>;
};
/** Rule 59: fixed, recorded replies; internal text never reaches a sender. */
export const NOTICES = {
	rate_limited:
		'You are sending messages faster than I can answer. Please wait a moment and send your message again.',
	unrecognised: (account: string, workspace: string) =>
		`This ${account} account is not recognised by ${workspace}. Ask an administrator to add it to your profile.`
} as const;
/** A new live message as admission reads it: the row, its conversation and the instance it arrived on. */
type Arrived = {
	row: string;
	instance: string;
	conversation: string;
	thread: string;
	group: boolean;
	email: boolean;
	/** The sender's handle can be believed: a platform's own account, or mail its receiving server vouched for. */
	proven: boolean;
	/** The conversation's status as the row arrived: `running` makes the message steering. */
	status: string;
	handle: HandleKind | null;
	/** What a notice calls the account: the driver, or a custom chat's definition. */ label: string;
	sender: string;
	sender_name: string | null;
	text: string;
	invocation: string;
	mentions: readonly string[];
	subject: string | null;
};
const AdmissionInput = Schema.Struct({
	message: Schema.String,
	mentions: Schema.optionalKey(Schema.Array(Schema.String))
});
const AdmissionRow = Schema.Struct({
	integration: Schema.String,
	conversation: Schema.String,
	sender: Schema.NullOr(Schema.String),
	sender_name: Schema.NullOr(Schema.String),
	text: Schema.String,
	invocation: Schema.NullOr(Schema.String),
	subject: Schema.NullOr(Schema.String),
	authenticated: Schema.NullOr(Schema.String),
	fresh: Schema.Boolean,
	thread: Schema.NullOr(Schema.String),
	kind: Schema.NullOr(Schema.String),
	status: Schema.String,
	definition: Schema.String,
	envoy: Schema.NullOr(Schema.String),
	serving: Schema.Boolean
});
const ShippingRow = Schema.Struct({
	integration: Schema.String,
	thread: Schema.NullOr(Schema.String),
	definition: Schema.String,
	last: Schema.NullOr(Schema.Struct({
		sender: Schema.NullOr(Schema.String),
		subject: Schema.NullOr(Schema.String)
	}))
});
export const envoys = Effect.fn('Envoys.make')(function* (cfg: EnvoysConfig) {
	const { manifest: m, db } = cfg.engine;
	const logs = yield* Logs;
	const clock =
		cfg.clock ?? Clock.currentTimeMillis.pipe(Effect.map((now) => new Date(now).toISOString()));
	const authorities = cfg.authorities ?? new Authorities(m, 'envoys');
	const windows = new RateWindows();
	/** One limited-message notice per sender per window, so a flood is never answered by a flood. */
	const warned = new Set<string>();
	const inflight = yield* FiberSet.make<unknown, EngineError>();
	/**
	 * Every limit is the envoy's own: `envoys.*` per sender and per subject, and the default `agent` limit keyed by the
	 * envoy, so a desk's turns share one budget whoever sends. A member's policies never add limits.
	 */
	const charge = Effect.fn('Envoys.charge')(function* (
		envoy: string,
		a: Arrived,
		key: 'envoys.receive' | 'envoys.unrecognised',
		turn: boolean = false
	) {
		const desk = yield* authorities.envoy(db, cfg.engine.live.publish, {
			envoy,
			instance: a.instance,
			sender: a.sender,
			member: null,
			dm: false
		});
		if (desk === null)
			return yield* Effect.fail(
				BoltError.make('stale', 'admission', `'${a.instance}' no longer serves the envoy ${envoy}`)
			);
		return windows.charge(
			[
				...charges_for(desk, [key], { sender: canonicalHandle(a.handle, a.sender), subject: envoy }),
				...(turn ? charges_for(desk, ['agent'], { actor: envoy }) : [])
			],
			Date.parse(yield* clock)
		);
	});
	/** A fixed reply in the sender's conversation: the chat, or the mail thread (to the sender, `Re:` its subject). */
	const notify = (a: Arrived, text: string) =>
		cfg.conversations.send(
			a.instance,
			a.email
				? { to: [a.sender], subject: reSubject(a.subject), text, thread: a.thread }
				: { to: a.conversation, text },
			{ kind: a.group ? 'group' : 'dm' }
		);
	/** A notice only the sender should read (not recognised): their own DM, never the group that mentioned the envoy. */
	const tell = (a: Arrived, text: string) =>
		a.group && !a.email
			? cfg.conversations.send(a.instance, { to: a.sender, text }, { kind: 'dm' })
			: notify(a, text);
	const mark = (row: string, set: string, ...params: Json[]) => {
		const chain = new Chain();
		chain.params.push(row, ...params);
		messagePiece(chain, `UPDATE sys_message SET ${set} WHERE id = $1`, 'id');
		return nativeCommit(db.write, cfg.engine.live.publish, chain, CapturedResult);
	};
	const subject = Effect.fn('Agents.subject')(function* (
		envoy: string,
		spec: EnvoySpec,
		a: Arrived
	) {
		const found = a.proven ? yield* memberByHandle(db, a.handle, a.sender) : null;
		const member = found !== null && (yield* authorities.member(db, cfg.engine.live.publish, found)) !== null ? found : null;
		if (member === null && spec.audience !== 'public') return null;
		return { envoy: { name: envoy, instance: a.instance, sender: a.sender, member, dm: !a.group } };
	});
	const admit = Effect.fn('Agents.admit')(function* (input: Json) {
		const { message: id, mentions = [] } = yield* Schema.decodeUnknownEffect(AdmissionInput, { onExcessProperty: 'error' })(input).pipe(
			Effect.mapError((error) => BoltError.make('invalid_input', 'decode', 'Envoy admission needs a message id and optional mention ids.', error))
		);
		const [res] = yield* db.read([
			sql(
				`SELECT m.integration, m.conversation, m.sender, m.sender_name, coalesce(m.text, '') AS text, m.invocation, m.email->>'subject' AS subject, m.email->>'authenticated' AS authenticated,
				m.addressed IS NULL AND m.role IS NULL AND m.deleted_at IS NULL AS fresh, c.thread, c.kind, c.status, i.integration AS definition, i.envoy, i.active AND i.owner IS NULL AS serving
			FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation JOIN sys_integration i ON i.id = m.integration WHERE m.id = $1`,
				id
			)
		]);
		if (res === undefined)
			return yield* BoltError.make('corrupt', 'decode', 'The envoy admission query returned no result.');
		const raw = res.rows[0];
		if (raw === undefined) return { admission: 'ignored' };
		const r = yield* Schema.decodeUnknownEffect(AdmissionRow)(raw).pipe(
			Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error))
		);
		// decided once: a retried run finds the row marked; a paused or redeployed instance answers nothing
		if (
			!r.fresh ||
			!r.serving ||
			r.envoy === null
		)
			return { admission: 'ignored' };
		const envoy = r.envoy,
			spec = yield* envoySpec(db, envoy);
		const name = r.definition,
			def = definitionOf(m, name),
			conv = def === undefined ? undefined : conversationOf(def);
		if (spec === undefined || def === undefined || conv === undefined) {
			// fail closed: an instance deployed to an envoy this release no longer declares answers nobody
			yield* logs.write({
				at: yield* clock,
				severity: 'warn',
				event: 'envoy.unknown',
				invocation: id,
				run: null,
				conversation: r.conversation,
				turn: null,
				attributes: { instance: r.integration, envoy }
			});
			return { admission: 'ignored' };
		}
		if (r.thread === null)
			return yield* BoltError.make('corrupt', 'admission', 'The incoming conversation has no provider thread.');
		return {
			admission: yield* decide(envoy, spec, {
				row: id,
				instance: r.integration,
				conversation: r.conversation,
				thread: r.thread,
				group: r.kind === 'group',
				email: conv.kind === 'email',
				proven: conv.kind !== 'email' || r.authenticated === 'true',
				status: r.status,
				handle: conv.handle,
				label: driver_name(def),
				sender: r.sender ?? '',
				sender_name: r.sender_name,
				text: r.text,
				invocation: r.invocation ?? 'direct',
				mentions,
				subject: r.subject
			})
		};
	});
	const decide = Effect.fn('Agents.decide')(function* (envoy: string, spec: EnvoySpec, a: Arrived) {
		const groups = spec.group_messages ?? 'mention_or_reply';
		const triage = cfg.triage;
		if (a.group && groups === 'disabled') return 'ignored';
		const trigger = a.invocation === 'mention' || a.invocation === 'reply';
		// a message that arrives while the turn runs is steering — queued at once, claimed at its next step,
		// never held. A DM steers; in a group only a message addressed to the envoy does, so chatter stays out of the turn.
		const steering = a.status === 'running' && !a.email && (!a.group || trigger);
		const addressed = !a.group || a.email || groups === 'all' || trigger || steering;
		// every chat message the envoy may answer is held for the sender's pause (email never is); the decider
		// is asked only under the envoy's triage scope, and an unaddressed group message is held only for it
		const decides = !a.email && triage?.envoy(spec, a.group) === true;
		const triaged = !a.email && !steering && triage !== undefined && (addressed || decides);
		if (!addressed && !triaged) {
			yield* mark(a.row, 'addressed = false');
			// A group message that named ids and was still not taken is the one case nobody can explain from outside: record
			// what the provider actually sent, so `Studio → Runtime` answers why a mention did not reach the envoy.
			if (a.group && a.mentions.length > 0)
				yield* logs.write({
					at: yield* clock,
					severity: 'info',
					event: 'conversation.unaddressed',
					invocation: a.row,
					run: null,
					conversation: a.conversation,
					turn: null,
					attributes: {
						instance: a.instance,
						sender: a.sender,
						mentions: a.mentions,
						text: preview(a.text)
					}
				});
			return 'ambient';
		}
		const as = yield* subject(envoy, spec, a);
		// an unknown sender's unaddressed message stays ambient: the notice answers only a mention or reply, as without triage
		if (as === null && !addressed) {
			yield* mark(a.row, 'addressed = false');
			return 'ambient';
		}
		if (as === null) {
			yield* mark(a.row, `addressed = true, refused = 'unregistered'`);
			if (
				canonicalHandle(a.handle, a.sender) !== '' &&
				(yield* charge(envoy, a, 'envoys.unrecognised')).ok
			)
				yield* tell(a, NOTICES.unrecognised(a.label, cfg.workspace ?? 'this workspace'));
			return 'unregistered';
		}
		// a triaged group row may become a turn, so it is charged like an addressed one; over the limit it stays ambient, unanswered
		const bounded = yield* charge(envoy, a, 'envoys.receive', true);
		if (!bounded.ok && !addressed) {
			yield* mark(a.row, 'addressed = false');
			return 'ambient';
		}
		if (!bounded.ok) {
			yield* mark(a.row, `addressed = true, refused = 'rate_limited'`);
			const key = `${envoy}\u0000${a.sender}\u0000${Math.floor(Date.parse(yield* clock) / 1000) + bounded.retryAfter}`;
			if (!warned.has(key)) {
				warned.add(key);
				yield* notify(a, NOTICES.rate_limited);
			}
			return 'rate_limited';
		}
		if (triaged) {
			const chain = new Chain();
			chain.params.push(a.row, JSON.stringify(as));
			const source = messagePiece(
				chain,
				`UPDATE sys_message SET ${QUEUE('pending')} WHERE id = $1`,
				'id'
			);
			// the sender sees typing while they are heard: a DM, or a group message that addressed the envoy
			yield* triage.hold(a.conversation, { chain, source, typing: !a.group || trigger });
			return 'pending';
		}
		yield* triage?.release(a.conversation) ?? Effect.void; // a steer or an email admits every pending row with it, and asks no decider
		yield* queue(a, as);
		yield* track(drain(a.conversation));
		return 'queued';
	});
	/** Rule 60: the row itself becomes the agent's queued input under its own sender; one row is history and transcript. */
	const QUEUE = (
		state: 'queued' | 'pending'
	) => `addressed = true, refused = NULL, role = 'user', state = '${state}', mode = 'agent', "as" = $2::jsonb,
		content = jsonb_build_object('text', coalesce(text, '')), author = coalesce(sender_name, sender)`;
	/**
	 * Queues the row and, in the same statement, the conversation's `agent.turn` at the turn lease: the drain this process
	 * starts takes it at once, and if the process dies first the run starts the turn.
	 */
	const queue = Effect.fn('Envoys.queue')(function* (a: Arrived, as: As) {
		const now = yield* clock,
			due = new Date(Date.parse(now) + AGENT_LIMITS.leaseMs).toISOString(),
			chain = new Chain();
		chain.params.push(a.row, JSON.stringify(as));
		const source = messagePiece(
			chain,
			`UPDATE sys_message SET ${QUEUE('queued')} WHERE id = $1`,
			'id'
		);
		enqueue(chain, {
			select: `SELECT '${TURN_RUN}'::text AS automation, jsonb_build_object('conversation', ${chain.p(a.conversation)}::text) AS input,
            ${chain.p(due)}::timestamptz AS due_at, 'schedule'::text AS cause, 0 AS depth WHERE EXISTS (SELECT 1 FROM ${source})
            AND NOT EXISTS (SELECT 1 FROM sys_run WHERE automation = '${TURN_RUN}' AND state = 'queued' AND input->>'conversation' = ${chain.p(a.conversation)})`
		});
		const result = yield* nativeCommit(db.write, cfg.engine.live.publish, chain,
			Schema.Struct({ ...CapturedResult.fields, due: Schema.NullOr(Schema.String) }),
			`${next_due(chain)}::text AS due`);
		if (result.due !== null) yield* cfg.announce(result.due);
	});
	const track = (work: Effect.Effect<unknown, EngineError>) =>
		FiberSet.run(inflight, work.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore));
	const drain = Effect.fn('Agents.drain')(function* (conversation: string) {
		const r = yield* cfg.agents.drain(conversation, { onWrite: live(conversation) });
		return { ran: r.ran, sent: yield* ship(conversation) };
	});
	/** Chat replies leave while the turn works: each finished assistant row is shipped as it is written (today's live updates). */
	const live = (conversation: string) => (row: { role: string | null }) =>
		row.role === 'assistant' ? ship(conversation) : Effect.succeed(0);
	const ship = Effect.fn('Agents.ship')(function* (conversation: string) {
		const [res] = yield* db.read([
			sql(
				`SELECT c.integration, c.thread, i.integration AS definition, (SELECT jsonb_build_object('sender', sender, 'subject', email->>'subject')
			FROM sys_message WHERE conversation = c.id AND direction = 'inbound' ORDER BY seq DESC LIMIT 1) AS last
			FROM sys_conversation c JOIN sys_integration i ON i.id = c.integration WHERE c.id = $1 AND i.owner IS NULL`,
				conversation
			)
		]);
		if (res === undefined)
			return yield* BoltError.make('corrupt', 'decode', 'The envoy shipping query returned no result.');
		const raw = res.rows[0];
		if (raw === undefined) return 0;
		const conv = yield* Schema.decodeUnknownEffect(ShippingRow)(raw).pipe(
			Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error))
		);
		const def = definitionOf(m, conv.definition);
		if (def === undefined) return 0;
		const email = conversationOf(def)?.kind === 'email', last = conv.last;
		if (email && conv.thread === null)
			return yield* BoltError.make('corrupt', 'deliver', 'The email conversation has no provider thread.');
		const message = email
			? `jsonb_build_object('to', jsonb_build_array($4::text), 'subject', $5::text, 'text', m.text, 'thread', $6::text)`
			: `jsonb_build_object('to', $1::text, 'text', m.text)`;
		const now = yield* clock,
			chain = new Chain();
		chain.params.push(
			conversation,
			conv.integration,
			now,
			...(email
				? [last?.sender ?? '', reSubject(last?.subject), conv.thread]
				: [])
		);
		const source = messagePiece(
			chain,
			`UPDATE sys_message m SET direction = 'outbound', status = 'queued', integration = $2, message = ${message},
            epoch = ${EPOCH}, next_attempt_at = $3::timestamptz
            WHERE m.conversation = $1 AND m.role = 'assistant' AND m.direction IS NULL AND coalesce(m.text, '') <> '' AND m.state IS DISTINCT FROM 'streaming'
            AND ${email ? `m.meta->>'tag' IN ('reply', 'failed')` : `(m.meta IS NULL OR m.meta->>'tag' IN ('reply', 'failed'))`}`,
			'm.id'
		);
		enqueue(chain, {
			select: `SELECT '${DELIVER}'::text AS automation, '{}'::jsonb AS input, $3::timestamptz AS due_at, 'schedule'::text AS cause, 0 AS depth WHERE EXISTS (SELECT 1 FROM ${source})`
		});
		const result = yield* nativeCommit(db.write, cfg.engine.live.publish, chain,
			Schema.Struct({ ...CapturedResult.fields, n: Schema.Number, due: Schema.NullOr(Schema.String) }),
			`(SELECT count(*) FROM ${source})::int AS n, ${next_due(chain)}::text AS due`);
		const n = result.n;
		if (result.due !== null) yield* cfg.announce(result.due);
		if (n > 0) yield* cfg.deliver;
		return n;
	});
	return {
		admit,
		drain,
		settled: FiberSet.awaitEmpty(inflight),
		/** The admission run: `runs.platform`, retried on a transient failure (a decided row is never decided again). */
		handlers: { [ADMIT]: admit },
		retries: { [ADMIT]: { attempts: 3, backoff: '10s' } }
	};
});
export type Envoys = Effect.Success<ReturnType<typeof envoys>>;
const reSubject = (s: unknown): string => {
	const x = typeof s === 'string' ? s : '';
	return /^re:/i.test(x) ? x : `Re: ${x}`;
};

export const EnvoysLive = Layer.effect(
	EnvoysTag,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			publisher = yield* Live,
			conversations = yield* ConversationsTag,
			outbound = yield* Outbound,
			agents = yield* AgentDrains,
			triage = yield* SmartThrottle,
			registry = yield* TurnHandlers,
			handlers = yield* RunHandlers,
			wake = yield* Wake;
		const config = yield* EnvoyConfig;
		const api = yield* envoys({
			...config,
			engine: { manifest, db, live: publisher },
			conversations,
			deliver: outbound.deliver,
			agents,
			triage,
			announce: wake.at
		});
		yield* registry.register('Envoy', api.drain);
		yield* handlers.register(api.handlers, api.retries);
		return api;
	})
);

export const EnvoyConfig = Context.Reference<
	Pick<EnvoysConfig, 'workspace' | 'clock' | 'authorities'>
>('bolt/EnvoyConfig', { defaultValue: () => ({}) });
