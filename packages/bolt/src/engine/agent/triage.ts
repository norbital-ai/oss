// Triage (P31, P40, P41, rule 60a): one mechanism for envoys and the in-app agent decides WHEN admitted messages start a
// turn, never under whose authority. A triaged row is stored `pending` and (re)queues the conversation's one platform run
// `agent.triage` at `min(arrival + TRIAGE_DEBOUNCE, first + TRIAGE_DEBOUNCE_MAX)`: a trailing debounce, so a burst is one
// `sys_1` call once the sender pauses; the chat shows typing from the moment the row is held. The run reads the last
// 20 settled messages as context and asks the AI facility's `sys_1` (text only: attachments as metadata) to
// `respond` (admit every pending row), `wait` (ask again ≤ 2 s later, exact time) or, in a group conversation only,
// `ignore` (the rows become ambient; the chat's typing stops); a direct conversation (envoy DM, in-app one-to-one) offers respond and wait alone.
// A failed decision admits now (`respond`): the single failure outcome, not a fallback. An envoy's chat message is held for
// the pause even where nothing decides (triage off, no `sys_1`): the run then admits it without asking. Mentions, replies,
// a message naming the assistant, and the person it last answered continuing that exchange (10 min, 30 after a question,
// nobody else spoken since) admit their burst without a decision call once the sender pauses; the in-app
// send-now and respond-now admit at once with every pending row, flush the queued decision and ask nothing. `delivered_turn` (set by the agent's claim, guarded by
// `IS NULL`) and `addressed` are the one record of what the agent received, so no row is new input twice.
import type { EnvoySpec } from '../../decl/runtime/agent.ts';
import { Clock, Context, Effect, FiberMap, Layer, Schema } from 'effect';
import { Chain } from '../write/sql.ts';
import { enqueue, nextDue } from '../runs/queue.ts';
import {
	filesOf,
	msg as messagePiece,
	post as postMessage,
	preview
} from '../conversations/store.ts';
import type { Json } from '../../decl/values.ts';
import type { EngineManifest } from '../manifest.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { Ai, Logs, Metering } from '../ports.ts';
import { Manifest, Live, Turns, Links, Wake, RunHandlers, type LiveShape } from '../services.ts';
import { type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Port } from '../port.ts';
import { TurnHandlers } from './turns.ts';
import { decisionEvent, failed, meter, type DecisionRequest } from '../decisions/index.ts';
import { FileRef, messageCommit, rowsOf, type As } from './schema.ts';
import { envoyName } from './context.ts';
import { envoySpec } from '../envoys/spec.ts';
const TRIAGE_RUN = 'agent.triage';
/** Engine constants (rule 72's budget row), never authoring options. */
export const TRIAGE_DEBOUNCE = 2000;
/** A burst never holds the first message longer than this, however long the sender keeps typing: the person is waiting, not the model. */
export const TRIAGE_DEBOUNCE_MAX = 6000;
const TRIAGE_CONTEXT_ROWS = 20;
/** One extra look at most: 6 s of debounce plus 2 s of wait is the whole silence a sender sees. */
export const TRIAGE_MAX_WAITS = 1;
/** A wait is short: the person sees a typing indicator, never a long silence. */
const WAIT_MS = 2000;
/** Below this the decider is guessing, and a guessed wait is only delay. */
const WAIT_MIN_PROBABILITY = 0.7;
/** Continuity: the person the assistant last answered keeps the exchange unnamed this long after its reply... */
const EXCHANGE_MS = 10 * 60_000;
/** ...and this long when that reply asked them something. */
const EXCHANGE_QUESTION_MS = 30 * 60_000;
type TriageAction = 'respond' | 'wait' | 'ignore';
/** One message's verdict: `delay` keeps the whole burst waiting, `no` leaves that message ambient for good. */
type Verdict = 'yes' | 'no' | 'delay';
const VERDICTS: {
	readonly [v in Verdict]: string;
} = {
	yes: 'this one is for the assistant and it is done; answer it now. Unnamed, it still is when it asks for the work the directive describes (a photo or a report to file, a job to update) or follows up on what the assistant just said to this sender',
	no: 'this one is not for the assistant; leave it',
	delay: 'this one is for the assistant but more is likely coming'
};
/** The score's levels: one per second of wait, so its continuous `score` is the wait in seconds (at most WAIT_MS). */
const WAIT_LEVELS = Array.from({ length: WAIT_MS / 1000 + 1 }, (_, i) => `${i} s`);
/** The in-app agent's name: what a person calls it ("Hello Norbius"), as an envoy is called by its own. */
const AGENT_NAME = 'Norbius';
/** Whether `text` names the assistant: a word match, `@` or not, any case. Saying its name is addressing it. */
const names = (text: string, name: string): boolean =>
	name.trim() !== '' &&
	new RegExp(
		`(^|[^\\p{L}\\p{N}])@?${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`,
		'iu'
	).test(text);
type TriageConfig = {
	engine: { manifest: EngineManifest; db: TenantDbShape; live?: Pick<LiveShape, 'publish'> };
	ai?: Ai['Service'];
	metering: Metering['Service'];
	clock: Effect.Effect<string>;
	announce: (at: string) => Effect.Effect<void>;
	drain: (conversation: string, envoy: boolean) => Effect.Effect<unknown, EngineError>;
	/** The linked chat's typing indicator, on or off (an in-app conversation has none). */
	typing?: (conversation: string, on: boolean) => Effect.Effect<void, EngineError>;
};
/** `typing`: the sender sees the assistant typing while the row is held (default on). */
type HeldMessage = { readonly chain: Chain; readonly source: string; readonly typing?: boolean };
type Row = {
	readonly [c: string]: Json;
};
const ms = (n: number) => `interval '${n} milliseconds'`;
/** A message's person: the provider handle an envoy row arrived from, or the in-app member. */
const WHO = (m: string) => `coalesce(${m}.sender, ${m}."as"->>'member')`;
/** An envoy's triage scope (default 'all') covers this conversation, unless the envoy declares `triage: false`. */
const decides = (spec: Pick<EnvoySpec, 'triage'>, group: boolean): boolean => {
	const t = spec.triage;
	if (t === false) return false;
	const scope = t?.scope ?? 'all';
	return scope === 'all' || scope === (group ? 'group' : 'dm');
};
const queued = (c: string) =>
	`automation = '${TRIAGE_RUN}' AND state = 'queued' AND input->>'conversation' = ${c}::text`;
/**
 * A new pending row (P40): the queued decision moves to `min(arrival + debounce, first + max)`, `first` the arrival of the
 * earliest row no decision has seen (a `wait` re-check carries none, so the new row starts it), and its wait count
 * resets; else one is inserted. ponytail: two racing holds may queue two runs; the second finds less pending, harmless.
 */
const debounced = (chain: Chain, conversation: string, at: string) => {
	chain.cte(
		'held',
		`UPDATE sys_run SET due_at = least(${at}::timestamptz + ${ms(TRIAGE_DEBOUNCE)}, coalesce((input->>'first')::timestamptz, ${at}::timestamptz) + ${ms(TRIAGE_DEBOUNCE_MAX)}),
        input = jsonb_build_object('conversation', ${conversation}::text, 'waits', 0, 'first', coalesce(input->'first', to_jsonb(${at}::timestamptz))) WHERE ${queued(conversation)} RETURNING due_at`
	);
	return enqueue(chain, {
		select: `SELECT '${TRIAGE_RUN}'::text AS automation,
        jsonb_build_object('conversation', ${conversation}::text, 'waits', 0, 'first', to_jsonb(${at}::timestamptz)) AS input,
        ${at}::timestamptz + ${ms(TRIAGE_DEBOUNCE)} AS due_at, 'schedule'::text AS cause, 0 AS depth WHERE NOT EXISTS (SELECT 1 FROM held)`
	});
};
/** A wait is never later than the recheck a newer arrival already queued. */
const recheck = (chain: Chain, conversation: string, at: string, waits: string) => {
	chain.cte(
		'held',
		`UPDATE sys_run SET due_at = least(due_at, ${at}::timestamptz) WHERE ${queued(conversation)} RETURNING due_at`
	);
	return enqueue(chain, {
		select: `SELECT '${TRIAGE_RUN}'::text AS automation,
        jsonb_build_object('conversation', ${conversation}::text, 'waits', ${waits}::int) AS input, ${at}::timestamptz AS due_at,
        'schedule'::text AS cause, 0 AS depth WHERE NOT EXISTS (SELECT 1 FROM held)`
	});
};
/**
 * The sender is still typing (a provider's presence report): the queued decision moves to `now + debounce`, never earlier
 * than it was and never past `first + max`. Answers `held`.
 */
export const heldLonger = (chain: Chain, conversation: string, at: string) =>
	chain.cte(
		'held',
		`UPDATE sys_run SET due_at = greatest(due_at, least(${at}::timestamptz + ${ms(TRIAGE_DEBOUNCE)}, (input->>'first')::timestamptz + ${ms(TRIAGE_DEBOUNCE_MAX)}))
        WHERE ${queued(conversation)} AND input ? 'first' RETURNING due_at`
	);
export const triage = Effect.fn('Triage.make')(function* (cfg: TriageConfig) {
	const debounce = yield* FiberMap.make<string, Json, EngineError>();
	const logs = yield* Logs;
	const { manifest: m, db } = cfg.engine;
	/** The host's wake, and a wake already open behind a long run (`nudge`): a decision never queues behind other automations. */
	const announce = cfg.announce;
	/** Rows a statement wrote `RETURNING ${MSG}` reach live transcripts as written (rule 65). */
	const published = Effect.fn('Triage.publish')(function* (rows: readonly Row[]) {
		const written = yield* rowsOf(rows.filter((row) => row['r'] !== undefined));
		if (written.length > 0) cfg.engine.live?.publish(messageCommit(written));
	});
	/** The deterministic flush (P40 (3)): every pending row is queued and the conversation's queued decision deleted. */
	const release = Effect.fn('Triage.release')(function* (conversation: string) {
		yield* FiberMap.remove(debounce, conversation);
		const chain = new Chain();
		chain.params.push(conversation);
		chain.cte('flush', `DELETE FROM sys_run WHERE ${queued('$1')} RETURNING id`);
		const source = messagePiece(
			chain,
			"UPDATE sys_message m SET state = 'queued' WHERE conversation = $1 AND state = 'pending'"
		);
		const [result] = yield* db.returning(
			Schema.Struct({ written: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
			chain.sql(
				`(SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM ${source} x) AS written`
			)
		);
		if (result === undefined)
			return yield* Effect.fail(
				BoltError.make('corrupt', 'commit', 'triage release returned no result')
			);
		return yield* published(result.written);
	});
	const admit = Effect.fn('Agents.admit')(function* (conversation: string, envoy: boolean) {
		yield* release(conversation);
		yield* cfg.drain(conversation, envoy);
	});
	const typing = (conversation: string, on: boolean) =>
		(cfg.typing?.(conversation, on) ?? Effect.void).pipe(
			Effect.tapCause(Effect.logWarning),
			Effect.ignore
		);
	const run = Effect.fn('Agents.run')(function* (input: Json) {
		const decoded = yield* Schema.decodeUnknownEffect(
			Schema.Struct({
				conversation: Schema.String,
				waits: Schema.optionalKey(Schema.Number.check(Schema.isInt()))
			})
		)(input).pipe(
			Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
		);
		const { conversation } = decoded,
			waits = decoded.waits ?? 0;
		const [convs, pendingRows, contextRows, posters, later, lastRows] = yield* db.read([
			{
				text: `SELECT envoy, kind, status FROM sys_conversation WHERE id = $1`,
				params: [conversation]
			},
			{
				text: `SELECT id, coalesce(author, sender_name, sender) AS sender, coalesce(text, '') AS text, (extract(epoch FROM coalesce(sent_at, created_at)) * 1000)::float8 AS at,
				invocation, ${filesOf('m')} AS files, ${WHO('m')} AS who FROM sys_message m WHERE conversation = $1 AND state = 'pending' ORDER BY seq`,
				params: [conversation]
			},
			{
				text: `SELECT role, coalesce(author, sender_name, sender) AS sender, coalesce(text, '') AS text, (extract(epoch FROM coalesce(sent_at, created_at)) * 1000)::float8 AS at
				FROM sys_message WHERE conversation = $1 AND coalesce(state, '') <> 'pending' AND coalesce(role, 'user') IN ('user', 'assistant')
				AND coalesce(text, '') <> '' ORDER BY seq DESC LIMIT ${TRIAGE_CONTEXT_ROWS}`,
				params: [conversation]
			},
			{
				text: `SELECT count(DISTINCT "as"->>'member')::int AS n FROM sys_message WHERE conversation = $1 AND role = 'user'`,
				params: [conversation]
			},
			{
				text: `SELECT (extract(epoch FROM min(due_at)) * 1000)::float8 AS due FROM sys_run WHERE ${queued('$1')}`,
				params: [conversation]
			},
			{
				// the assistant's last reply, the person whose turn it answered, and who has spoken (settled) since
				text: `SELECT coalesce(a.text, '') AS text, (extract(epoch FROM coalesce(a.sent_at, a.created_at)) * 1000)::float8 AS at, p.who AS partner, p.name,
				(SELECT coalesce(jsonb_agg(${WHO('o')}), '[]'::jsonb) FROM sys_message o WHERE o.conversation = $1 AND o.seq > a.seq
					AND coalesce(o.role, 'user') = 'user' AND o.direction IS DISTINCT FROM 'outbound' AND coalesce(o.state, '') <> 'pending' AND ${WHO('o')} IS NOT NULL) AS since
				FROM sys_message a LEFT JOIN LATERAL (SELECT ${WHO('u')} AS who, coalesce(u.author, u.sender_name, u.sender) AS name FROM sys_message u
					WHERE u.conversation = $1 AND u.delivered_turn = a.turn ORDER BY u.seq DESC LIMIT 1) p ON true
				WHERE a.conversation = $1 AND a.role = 'assistant' AND coalesce(a.text, '') <> '' ORDER BY a.seq DESC LIMIT 1`,
				params: [conversation]
			}
		]);
		const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
			schema: S,
			rows: readonly unknown[]
		) =>
			Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
				Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error))
			);
		const conv = (yield* decode(
			Schema.Struct({
				envoy: Schema.NullOr(Schema.String),
				kind: Schema.NullOr(Schema.String),
				status: Schema.String
			}),
			convs?.rows ?? []
		))[0];
		const pending = yield* decode(
			Schema.Struct({
				id: Schema.String,
				sender: Schema.NullOr(Schema.String),
				text: Schema.String,
				at: Schema.Number,
				invocation: Schema.NullOr(Schema.String),
				files: Schema.Array(FileRef),
				who: Schema.NullOr(Schema.String)
			}),
			pendingRows?.rows ?? []
		);
		const last = (yield* decode(
			Schema.Struct({
				text: Schema.String,
				at: Schema.Number,
				partner: Schema.NullOr(Schema.String),
				name: Schema.NullOr(Schema.String),
				since: Schema.Array(Schema.String)
			}),
			lastRows?.rows ?? []
		))[0];
		const context = yield* decode(
			Schema.Struct({
				role: Schema.NullOr(Schema.String),
				sender: Schema.NullOr(Schema.String),
				text: Schema.String,
				at: Schema.Number
			}),
			contextRows?.rows ?? []
		);
		const count =
			(yield* decode(Schema.Struct({ n: Schema.Number }), posters?.rows ?? []))[0]?.n ?? 0;
		// a stopped conversation triages nothing; with nothing pending there is nothing to decide
		if (conv === undefined || conv.status === 'stopped' || pending.length === 0)
			return { pending: 0 };
		// the sender kept typing (`heldLonger`): the queued run decides at its later time, not this timer
		// a timer firing on time can read `due` a hair late (a float epoch): only a real postponement waits, and then this
		// decision sleeps until it instead of returning held with nothing left to wake it
		const due = later?.rows[0]?.['due'];
		const left = typeof due === 'number' ? due - Date.parse(yield* cfg.clock) : 0;
		// (a newer arrival's hold replaces this fiber in `debounce`, so the rows read above are still the burst)
		if (left > 25) yield* Effect.sleep(left);
		const envoyKey = conv.envoy,
			envoy = envoyKey !== null;
		if (waits >= TRIAGE_MAX_WAITS) {
			yield* admit(conversation, envoy);
			return { action: 'respond', bound: true };
		}
		const spec = envoyKey === null ? undefined : yield* envoySpec(m, db, envoyKey);
		// P41: a group (an envoy group, or an in-app conversation more than one member posted in) may be not for the agent;
		// a direct one (an envoy DM, an in-app one-to-one) always is, so it decides only when
		const group = envoy ? conv.kind === 'group' : count > 1;
		// held for the pause alone: an envoy whose triage is off, or no `sys_1` to ask, admits the burst as it is
		if (envoy && (cfg.ai === undefined || spec === undefined || !decides(spec, group))) {
			yield* admit(conversation, envoy);
			return { action: 'respond', held: true };
		}
		const assistant = envoy ? envoyName(spec?.name) : AGENT_NAME;
		const now = yield* cfg.clock;
		// continuity (a group's; a direct conversation is always addressed): the assistant's last reply answered this person's turn within 10 min (30 when it asked them something)
		// and nobody else has spoken since — their unnamed next message continues that exchange ("Ya put bob under them")
		const exchange =
			group &&
			last !== undefined &&
			last.partner !== null &&
			Date.parse(now) - last.at <=
				(last.text.trim().endsWith('?') ? EXCHANGE_QUESTION_MS : EXCHANGE_MS)
				? { ...last, partner: last.partner }
				: undefined;
		let unbroken = exchange?.since.every((who) => who === exchange.partner) ?? false;
		const continues = pending.map((r) => (unbroken &&= r.who === exchange?.partner));
		// a mention or a reply admits its whole burst without asking; saying the assistant's name addresses it as well, and
		// so does continuing its exchange: those rows are answered without asking the decider, and a burst of nothing else is admitted at once
		const named = pending.map(
			(r, i) =>
				r.invocation === 'mention' ||
				r.invocation === 'reply' ||
				names(r.text, assistant) ||
				continues[i] === true
		);
		if (
			named.every(Boolean) ||
			pending.some((r) => r.invocation === 'mention' || r.invocation === 'reply')
		) {
			yield* admit(conversation, envoy);
			return { action: 'respond', named: true };
		}
		const allowed: TriageAction[] = group ? ['respond', 'wait', 'ignore'] : ['respond', 'wait'];
		const pendingIds = pending.map((r) => r.id);
		const at = (r: { readonly at: number }) => new Date(r.at).toISOString();
		// attachments go in as metadata only (P37 (3)): name, mime, size, and a caption or text when there is one
		const fileIds = pending.flatMap((r) =>
			r.files.flatMap((f) => (f.id === undefined ? [] : [f.id]))
		);
		const sizes = new Map<string, number>(
			fileIds.length === 0
				? []
				: (yield* db.read([
						{
							text: `SELECT id, size FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
							params: [JSON.stringify(fileIds)]
						}
					]))[0]!.rows.map((x) => [String(x['id']), Number(x['size'])])
		);
		const attachments = (r: (typeof pending)[number]): Json[] =>
			r.files.map((f) => {
				const size = f.id === undefined ? undefined : sizes.get(f.id);
				return {
					name: f.name ?? 'file',
					mime: f.mime ?? '',
					...(size === undefined ? {} : { size }),
					...(f.caption === undefined ? {} : { caption: preview(f.caption) }),
					...(f.text === undefined ? {} : { text: preview(f.text) })
				};
			});
		const req: DecisionRequest = {
			state: {
				directive: preview(spec?.task ?? m.agent.internal ?? ''),
				conversation: envoy
					? group
						? 'envoy group'
						: 'envoy DM'
					: group
						? 'in-app, shared'
						: 'in-app, one-to-one',
				actions: allowed,
				earlier: context.toReversed().map((r) => ({
					from: r.role === 'assistant' ? 'assistant' : (r.sender ?? 'someone'),
					text: preview(r.text),
					at: at(r),
					contextOnly: true
				})),
				pending: pending.map((r) => {
					const files = attachments(r);
					return {
						id: r.id,
						from: r.sender ?? 'someone',
						text: preview(r.text),
						at: at(r),
						...(files.length === 0 ? {} : { attachments: files })
					};
				}),
				secondsSinceFirstPending: Math.round(Math.max(0, Date.parse(now) - pending[0]!.at) / 1000),
				addressesAssistant: pending.some(
					(r) => r.invocation === 'mention' || r.invocation === 'reply'
				),
				// An envoy is named, and a message that says its name is for it whether or not the mention was mechanical:
				// without this the decider is asked about a nameless assistant and reads `hi <name>` as not addressed.
				assistant,
				// whom the assistant is talking with and what it last said: "yes", "ya do that" from them answer it
				...(exchange === undefined
					? {}
					: {
							talkingWith: exchange.name ?? 'someone',
							assistantLastMessage: preview(exchange.text)
						})
			} as DecisionRequest['state'],
			// ONE call, one verdict per message: the decider is asked about each pending message by name, so a burst is
			// judged together and blind to each other rather than folded into a single action for the whole conversation.
			questions: {
				...Object.fromEntries(
					pending.map((r, i) => [
						`m${i}`,
						{
							type: 'choice' as const,
							instructions: `${i + 1}. Message ${i + 1} of ${pending.length} from ${r.sender ?? 'someone'}: should ${assistant} answer this one?${
								exchange !== undefined && r.who === exchange.partner
									? ` ${assistant} is talking with them; its last message to them was: "${preview(exchange.text)}"`
									: ''
							}`,
							criteria: VERDICTS
						}
					])
				),
				wait: {
					type: 'score',
					instructions:
						'If any message is better answered after a pause, how many seconds until the next part is likely to arrive?',
					criteria: WAIT_LEVELS
				}
			}
		};
		const d = yield* (cfg.ai === undefined ? Port.unavailable('ai') : cfg.ai.ask(req)).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					error._tag === 'Unavailable'
						? { kind: 'unavailable' as const, facility: error.facility, reason: error.reason }
						: {
								kind: error.kind,
								message: error.message,
								...(error.status === undefined ? {} : { status: error.status })
							}
				)
			)
		);
		const call = globalThis.crypto.randomUUID(),
			bad = failed(d);
		// a direct conversation offers no `ignore`; an answer outside the three verdicts is read as it
		// a failed decision answers a DM (never leave a person unanswered) but stays quiet in a group, where an outage must
		// not turn the envoy into a bot that answers every message; a `no` row stays ambient context for the next address
		const fallback: Verdict = (allowed as readonly string[]).includes('ignore') ? 'no' : 'yes';
		const verdictOf = (i: number): Verdict => {
			const a = bad ? undefined : d.answers[`m${i}`];
			const c = a?.type === 'choice' ? a.choice : undefined;
			return c === 'yes' || c === 'no' || c === 'delay' ? c : fallback;
		};
		// A direct conversation is never left unanswered: it offers no `ignore`, so a `no` read there is a misread of the
		// decider — a DM from one person is always theirs to have answered — and is taken as `yes`.
		const verdicts = pending.map((_, i) => {
			const v = verdictOf(i);
			return named[i] ? (v === 'delay' ? 'delay' : 'yes') : !group && v === 'no' ? 'yes' : v;
		});
		// a wait costs the person seconds of silence: only a probable one holds. A `delay` whose pause is a guess is still a
		// message for the assistant, so it is answered now rather than left — doubt about the timing is no reason to drop it.
		const waitAnswer = bad ? undefined : d.answers['wait'];
		const holds =
			verdicts.includes('delay') &&
			waitAnswer?.type === 'score' &&
			waitAnswer.confidence >= WAIT_MIN_PROBABILITY;
		const answerNow = verdicts.includes('yes') || (!holds && verdicts.includes('delay'));
		const action: TriageAction = holds ? 'wait' : answerNow ? 'respond' : 'ignore';
		const event = {
			...decisionEvent('triage', req, d),
			action,
			verdicts,
			pending: pending.length,
			waits
		};
		yield* logs.write({
			at: now,
			severity: bad ? 'warn' : 'info',
			event: 'decision.made',
			invocation: call,
			run: null,
			conversation,
			turn: null,
			attributes: event
		});
		if (action === 'wait') {
			const w = bad ? undefined : d.answers['wait'];
			// the continuous score is the wait in seconds (1.4 → 1.4 s), clipped to WAIT_MS
			const seconds = Math.min(WAIT_MS / 1000, Math.max(0, w?.type === 'score' ? w.score : 0));
			const at = new Date(Date.parse(now) + Math.round(seconds * 1000)).toISOString();
			const chain = new Chain();
			chain.params.push(conversation, at, waits + 1);
			recheck(chain, '$1', '$2', '$3');
			const [wake] = yield* db.returning(
				Schema.Struct({ due: Schema.NullOr(Schema.String) }),
				chain.sql(`least((SELECT min(due_at) FROM held), ${nextDue(chain)})::text AS due`)
			);
			if (wake?.due !== null && wake?.due !== undefined) yield* announce(wake.due);
		} else {
			// only the rows the decider saw; a row that arrived meanwhile has its own queued decision. A `no` verdict is
			// left exactly as an ignored conversation is — the message stays as ambient context for the next address.
			const left = pending
				.filter((_, i) => action === 'ignore' || verdicts[i] === 'no')
				.map((r) => r.id);
			if (left.length > 0) {
				const chain = new Chain();
				chain.params.push(conversation, JSON.stringify(left));
				const source = messagePiece(
					chain,
					"UPDATE sys_message m SET state = NULL, addressed = false WHERE conversation = $1 AND state = 'pending' AND id IN (SELECT jsonb_array_elements_text($2::jsonb))"
				);
				const [result] = yield* db.returning(
					Schema.Struct({ written: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
					chain.sql(
						`(SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM ${source} x) AS written`
					)
				);
				if (result === undefined)
					return yield* Effect.fail(
						BoltError.make('corrupt', 'commit', 'triage decision returned no result')
					);
				yield* published(result.written);
			}
		}
		yield* meter(cfg.metering, d, call);
		if (action === 'respond') yield* admit(conversation, envoy);
		// nothing here was for the assistant: the chat stops showing it typing
		if (action === 'ignore' && envoy) yield* typing(conversation, false);
		return event;
	});
	const hold = Effect.fn('Triage.hold')(function* (conversation: string, row: HeldMessage) {
		// a held sender sees typing from arrival, not from the decision: the burst is being read, not ignored
		if (row.typing !== false) yield* typing(conversation, true);
		const { chain, source } = row;
		chain.cte('m', `SELECT * FROM ${source}`);
		const conversationSql = chain.p(conversation),
			at = chain.p(yield* cfg.clock);
		const decision = debounced(chain, conversationSql, at);
		const [result] = yield* db.returning(
			Schema.Struct({
				written: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
				triage_due: Schema.NullOr(Schema.Number)
			}),
			chain.sql(`(SELECT coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM m) AS written,
                (SELECT (extract(epoch FROM min(due_at)) * 1000)::float8 FROM (SELECT due_at FROM held UNION ALL SELECT due_at FROM ${decision}) d) AS triage_due`)
		);
		if (result === undefined)
			return yield* Effect.fail(
				BoltError.make('corrupt', 'commit', 'triage hold returned no result')
			);
		const due = result.triage_due;
		if (due !== null) yield* announce(new Date(due).toISOString());
		yield* published(result.written);
		if (due !== null)
			yield* FiberMap.run(
				debounce,
				conversation,
				Effect.sleep(Math.max(0, due - (yield* Clock.currentTimeMillis))).pipe(
					Effect.andThen(run({ conversation, waits: 0 })),
					Effect.tapCause(Effect.logWarning),
					Effect.catch(() => Effect.succeed(null))
				)
			);
		return result.written;
	});
	return {
		/** The in-app agent is triaged when the host binds the AI facility, unless the workspace declares `agent: { triage: false }`. */
		inApp: (): boolean => cfg.ai !== undefined && m.workspace.agent?.triage !== false,
		/** An envoy's message is decided under its `scope` (default 'all'), unless the envoy declares `triage: false`. */
		envoy: (spec: Pick<EnvoySpec, 'triage'>, group: boolean): boolean =>
			cfg.ai !== undefined && decides(spec, group),
		/**
		 * Stores a shared message piece and its decision in one statement; answers the piece's written rows.
		 */
		hold,
		post: Effect.fn('Agents.post')(function* (o: {
			conversation: string;
			as: As;
			text: string;
			author: string;
			mode: 'agent' | 'plan';
			files?: readonly Json[];
			/** The person's IANA zone (their clock, rule 57), kept on the row as an untriaged post keeps it. */ tz?: string;
		}) {
			const chain = new Chain();
			const source = postMessage(chain, {
				conversation: o.conversation,
				role: 'user',
				content: { text: o.text, ...(o.tz === undefined ? {} : { tz: o.tz }) },
				text: o.text,
				state: 'pending',
				mode: o.mode,
				as: o.as,
				author: o.author,
				files: o.files ?? []
			});
			const written = yield* hold(o.conversation, { chain, source });
			const rows = yield* rowsOf(written);
			const row = rows[0];
			if (row === undefined)
				return yield* Effect.fail(
					BoltError.make('corrupt', 'commit', 'a triaged post returned no message')
				);
			return { id: row.id };
		}),
		/** Deterministic trigger: every pending row is queued with it and the queued decision flushed (the caller queues its own row and drains). */
		release,
		/** `sys_conversation.respondNow`: the pending rows alone, admitted at once with no decision call. */
		admit,
		handlers: { [TRIAGE_RUN]: run }
	};
});
export type Triage = Effect.Success<ReturnType<typeof triage>>;
export class TriageService extends Context.Service<TriageService, Triage>()('bolt/Triage') {}
export const TriageLive = Layer.effect(
	TriageService,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			live = yield* Live,
			ai = yield* Ai,
			metering = yield* Metering,
			turns = yield* Turns,
			wake = yield* Wake,
			links = yield* Links,
			handlers = yield* RunHandlers,
			registry = yield* TurnHandlers;
		const api = yield* triage({
			engine: { manifest, db, live },
			...(Ai.hasSystem1(ai) ? { ai } : {}),
			metering,
			clock: Clock.currentTimeMillis.pipe(Effect.map((now) => new Date(now).toISOString())),
			announce: wake.at,
			drain: (conversation, envoy) => turns.drain(conversation, envoy ? 'Envoy' : 'Agent'),
			typing: (conversation, on) =>
				Effect.gen(function* () {
					const [rows] = yield* db.read([
						{
							text: 'SELECT integration, thread FROM sys_conversation WHERE id = $1',
							params: [conversation]
						}
					]);
					const row = rows?.rows[0];
					if (typeof row?.['integration'] === 'string' && typeof row['thread'] === 'string')
						yield* links
							.typing(row['integration'], row['thread'], on)
							.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
				})
		});
		yield* registry.release(api.release);
		yield* handlers.register(api.handlers);
		return api;
	})
);
