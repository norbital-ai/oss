// Triage (P31, P40, P41, rule 60a): one mechanism for envoys and the in-app agent decides WHEN admitted messages start a
// turn, never under whose authority. A triaged row is stored `pending` and (re)queues the conversation's one platform run
// `agent.triage` at `min(arrival + TRIAGE_DEBOUNCE, first + TRIAGE_DEBOUNCE_MAX)`: a trailing debounce, so a burst is one
// `sys_1` call once the sender pauses. The run asks the AI facility's `sys_1` (text only: attachments as metadata) to
// `respond` (admit every pending row), `wait` (ask again ≤ 10 s later, exact time) or, in a group conversation only,
// `ignore` (the rows become ambient); a direct conversation (envoy DM, in-app one-to-one) offers respond and wait alone.
// A failed decision admits now (`respond`): the single failure outcome, not a fallback. Without an AI facility nothing
// is triaged. Mentions, replies, the in-app send-now and respond-now are deterministic: they admit at once with every
// pending row, flush the queued decision and ask nothing. `delivered_turn` (set by the agent's claim, guarded by
// `IS NULL`) and `ambient` are the one record of what the agent received, so no row is new input twice.
import { randomUUID } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import type { AiPort, DeadlinesPort, EngineManifest, MeteringPort, TenantDb } from '../contracts.ts';
import { ask, choiceOf, decisionEvent, failed, meter, type DecisionRequest } from '../decisions/index.ts';
import { messageCommit, MSG, preview, rowsOf, type As } from './schema.ts';
import type { LiveHub } from '../live/hub.ts';
import type { Runs } from '../runs/index.ts';

export const TRIAGE_RUN = 'agent.triage';
/** Engine constants (rule 72's budget row), never authoring options. */
export const TRIAGE_DEBOUNCE = 2_000;
export const TRIAGE_DEBOUNCE_MAX = 10_000;
export const TRIAGE_CONTEXT_ROWS = 20;
export const TRIAGE_MAX_WAITS = 12;
const WAIT_MS = 10_000;
/** Below this the decider is guessing, and a guessed wait is only delay. */
const WAIT_MIN_PROBABILITY = 0.7;

export type TriageAction = 'respond' | 'wait' | 'ignore';
const ACTIONS: { readonly [a in TriageAction]: string } = {
	respond: 'the sender is done and expects an answer now',
	wait: 'more parts of the message are likely coming',
	ignore: 'not meant for the assistant',
};
/** The score's levels: one per second of wait, so its continuous `score` is the wait in seconds. */
/** 0 s … 9 s: the decision service accepts at most 10 score levels; the score is the wait in seconds. */
const WAIT_LEVELS = Array.from({ length: 10 }, (_, i) => `${i} s`);

export type TriageConfig = {
	engine: { manifest: EngineManifest; db: TenantDb; live?: Pick<LiveHub, 'publish'>; runs?: Pick<Runs, 'nudge'> };
	ai?: AiPort; metering?: MeteringPort; deadlines?: DeadlinesPort; scope?: string;
	clock: () => string;
	/** Runs a conversation whose rows were just queued: the envoy drain (which ships the replies) or the in-app one. */
	drain: (conversation: string, envoy: boolean) => Promise<unknown>;
};

type Q = { text: string; params: Json[] };
type Row = { readonly [c: string]: Json };
const isObj = (v: unknown): v is { readonly [k: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);
const ms = (n: number) => `interval '${n} milliseconds'`;
const queued = (c: string) => `automation = '${TRIAGE_RUN}' AND state = 'queued' AND input->>'conversation' = ${c}::text`;

/**
 * A new pending row (P40): the queued decision moves to `min(arrival + debounce, first + max)`, `first` the arrival of the
 * earliest row no decision has seen (a `wait` re-check carries none, so the new row starts it), and its wait count
 * resets; else one is inserted. ponytail: two racing holds may queue two runs; the second finds less pending, harmless.
 */
const debounced = (c: string, at: string) => `held AS (UPDATE sys_run SET
		due_at = least(${at}::timestamptz + ${ms(TRIAGE_DEBOUNCE)}, coalesce((input->>'first')::timestamptz, ${at}::timestamptz) + ${ms(TRIAGE_DEBOUNCE_MAX)}),
		input = jsonb_build_object('conversation', ${c}::text, 'waits', 0, 'first', coalesce(input->'first', to_jsonb(${at}::timestamptz)))
	WHERE ${queued(c)} RETURNING due_at),
	decision AS (INSERT INTO sys_run (id, automation, input, due_at, cause, depth) SELECT gen_random_uuid()::text, '${TRIAGE_RUN}',
		jsonb_build_object('conversation', ${c}::text, 'waits', 0, 'first', to_jsonb(${at}::timestamptz)), ${at}::timestamptz + ${ms(TRIAGE_DEBOUNCE)}, 'schedule', 0
		WHERE NOT EXISTS (SELECT 1 FROM held) RETURNING due_at)`;
/** A `wait` (rule 60a): the re-check at `at`, never later than a run already queued (a row that arrived meanwhile). */
const recheck = (c: string, at: string, waits: string) => `held AS (UPDATE sys_run SET due_at = least(due_at, ${at}::timestamptz) WHERE ${queued(c)} RETURNING id),
	decision AS (INSERT INTO sys_run (id, automation, input, due_at, cause, depth) SELECT gen_random_uuid()::text, '${TRIAGE_RUN}',
		jsonb_build_object('conversation', ${c}::text, 'waits', ${waits}::int), ${at}::timestamptz, 'schedule', 0 WHERE NOT EXISTS (SELECT 1 FROM held) RETURNING id)`;

export function triage(cfg: TriageConfig) {
	const { manifest: m, db } = cfg.engine;
	/** The host's wake, and a wake already open behind a long run (`nudge`): a decision never queues behind other automations. */
	const announce = (at: string) => { cfg.deadlines?.announce(cfg.scope ?? '', at); cfg.engine.runs?.nudge(at); };
	/** Rows a statement wrote `RETURNING ${MSG}` reach live transcripts as written (rule 65). */
	const published = (rows: readonly Row[]) => {
		const written = rowsOf(rows.filter((x) => x['r'] !== undefined));
		if (written.length > 0) cfg.engine.live?.publish(messageCommit(written));
	};
	/** The deterministic flush (P40 (3)): every pending row is queued and the conversation's queued decision deleted. */
	const release = async (conversation: string) =>
		published((await db.write({ text: `WITH flush AS (DELETE FROM sys_run WHERE ${queued('$1')} RETURNING id)
			UPDATE sys_message m SET state = 'queued' WHERE conversation = $1 AND state = 'pending' RETURNING ${MSG}`, params: [conversation] })).rows);

	/** Every pending row of the conversation is queued, then the turn runs (a deterministic trigger, `respond`, the bound). */
	async function admit(conversation: string, envoy: boolean): Promise<void> {
		await release(conversation);
		await cfg.drain(conversation, envoy);
	}

	/** One decision: the platform run `agent.triage` (rule 48). */
	async function run(input: Json): Promise<Json> {
		const { conversation, waits } = input as { conversation: string; waits: number };
		const [convs, pendingRows, contextRows, posters] = await db.read([
			{ text: `SELECT envoy, kind, status FROM sys_conversation WHERE id = $1`, params: [conversation] },
			{ text: `SELECT id, coalesce(author, sender_name, sender) AS sender, coalesce(text, '') AS text, (extract(epoch FROM coalesce(sent_at, created_at)) * 1000)::float8 AS at,
				invocation, files FROM sys_message WHERE conversation = $1 AND state = 'pending' ORDER BY seq`, params: [conversation] },
			{ text: `SELECT role, coalesce(author, sender_name, sender) AS sender, coalesce(text, '') AS text, (extract(epoch FROM coalesce(sent_at, created_at)) * 1000)::float8 AS at
				FROM sys_message WHERE conversation = $1 AND coalesce(state, '') <> 'pending' AND coalesce(role, 'user') IN ('user', 'assistant')
				AND coalesce(text, '') <> '' ORDER BY seq DESC LIMIT ${TRIAGE_CONTEXT_ROWS}`, params: [conversation] },
			{ text: `SELECT count(DISTINCT "as"->>'member')::int AS n FROM sys_message WHERE conversation = $1 AND role = 'user'`, params: [conversation] },
		]);
		const conv = convs!.rows[0];
		const pending = pendingRows!.rows;
		// a stopped conversation triages nothing; with nothing pending there is nothing to decide
		if (conv === undefined || conv['status'] === 'stopped' || pending.length === 0) return { pending: 0 };
		const envoyName = conv['envoy'] as string | null, envoy = envoyName !== null;
		if (waits >= TRIAGE_MAX_WAITS) { await admit(conversation, envoy); return { action: 'respond', bound: true }; }

		const spec = (envoy ? m.envoys[envoyName] : undefined) as { task?: string; groupMessages?: string } | undefined;
		// P41: a group (an envoy group, or an in-app conversation more than one member posted in) may be not for the agent;
		// a direct one (an envoy DM, an in-app one-to-one) always is, so it decides only when
		const group = envoy ? conv['kind'] === 'group' : Number(posters!.rows[0]?.['n'] ?? 0) > 1;
		const allowed: TriageAction[] = group ? ['respond', 'wait', 'ignore'] : ['respond', 'wait'];
		const now = cfg.clock();
		const pendingIds = pending.map((r) => String(r['id']));
		const at = (r: Row) => new Date(Number(r['at'])).toISOString();
		// attachments go in as metadata only (P37 (3)): name, mime, size, and a caption or text when there is one
		const refOf = (f: Json) => isObj(f) && isObj(f['file']) ? f['file'] : f; // an envoy's descriptor, or a panel FileRef
		const fileIds = pending.flatMap((r) => (Array.isArray(r['files']) ? r['files'] : []).flatMap((f) => { const ref = refOf(f); return isObj(ref) && typeof ref['id'] === 'string' ? [ref['id']] : []; }));
		const sizes = new Map<string, number>(fileIds.length === 0 ? [] : (await db.read([{ text: `SELECT id, size FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(fileIds)] }]))[0]!.rows.map((x) => [String(x['id']), Number(x['size'])]));
		const attachments = (r: Row): Json[] => (Array.isArray(r['files']) ? r['files'] : []).flatMap((f) => {
			const ref = refOf(f), d = isObj(f) ? f : {};
			if (!isObj(ref)) return [];
			const size = sizes.get(String(ref['id'])) ?? ref['size'];
			return [{ name: String(ref['name'] ?? 'file'), mime: String(ref['mime'] ?? ''), ...(typeof size === 'number' ? { size } : {}),
				...(typeof d['caption'] === 'string' ? { caption: preview(d['caption']) } : {}), ...(typeof d['text'] === 'string' ? { text: preview(d['text']) } : {}) }];
		});
		const req: DecisionRequest = {
			state: {
				directive: preview(spec?.task ?? m.agent.internal ?? ''),
				conversation: envoy ? (group ? 'envoy group' : 'envoy DM') : group ? 'in-app, shared' : 'in-app, one-to-one',
				actions: allowed,
				earlier: contextRows!.rows.toReversed().map((r) => ({ from: r['role'] === 'assistant' ? 'assistant' : (r['sender'] as string | null) ?? 'someone',
					text: preview(String(r['text'])), at: at(r), contextOnly: true })),
				pending: pending.map((r) => { const files = attachments(r);
					return { id: String(r['id']), from: (r['sender'] as string | null) ?? 'someone', text: preview(String(r['text'])), at: at(r), ...(files.length === 0 ? {} : { attachments: files }) }; }),
				secondsSinceFirstPending: Math.round(Math.max(0, Date.parse(now) - Number(pending[0]!['at'])) / 1000),
				addressesAssistant: pending.some((r) => r['invocation'] === 'mention' || r['invocation'] === 'reply'),
			} as DecisionRequest['state'],
			questions: {
				action: { type: 'choice', instructions: 'You decide when an assistant answers this conversation. What should it do now?',
					criteria: Object.fromEntries(allowed.map((a) => [a, ACTIONS[a]])) },
				wait: { type: 'score', instructions: 'If the assistant waits, how many seconds until the next part is likely to arrive?', criteria: WAIT_LEVELS },
			},
		};
		const d = await ask(cfg.ai, req);
		const call = randomUUID(), bad = failed(d);
		// a direct conversation offers no `ignore`; any answer outside `allowed` is read as `respond`
		// a failed decision answers a DM (never leave a person unanswered) but stays quiet in a group, where an outage must
		// not turn the envoy into a bot that answers every message; ignored rows stay ambient context for the next address
		const fallback: TriageAction = (allowed as readonly string[]).includes('ignore') ? 'ignore' : 'respond';
		const chosen = bad ? fallback : (allowed as readonly string[]).includes(choiceOf(d, 'action') ?? '') ? choiceOf(d, 'action') as TriageAction : fallback;
		// a wait costs the person seconds of silence: only a probable one holds; else the likelier of the other actions
		const p = (a: string) => { const x = bad ? undefined : d.answers['action']; return x?.type === 'choice' ? x.probabilities[a] ?? 0 : 0; };
		const action: TriageAction = chosen !== 'wait' || p('wait') >= WAIT_MIN_PROBABILITY ? chosen
			: allowed.filter((a) => a !== 'wait').reduce((best, a) => p(a) > p(best) ? a : best, 'respond' as TriageAction);
		const event = { ...decisionEvent('triage', req, d) as { readonly [k: string]: Json }, action, pending: pending.length, waits };
		const log = `logged AS (INSERT INTO sys_event (at, severity, event, invocation, conversation, attributes) VALUES ($2::timestamptz, $3, 'decision.made', $4, $1, $5::jsonb) RETURNING 1)`;
		const base: Json[] = [conversation, now, bad ? 'warn' : 'info', call, JSON.stringify(event)];
		if (action === 'wait') {
			const w = bad ? undefined : d.answers['wait'];
			// the continuous score is the wait in seconds (3.4 → 3.4 s), clipped to 10 s
			const seconds = Math.min(WAIT_MS / 1000, Math.max(0, w?.type === 'score' ? w.score : 0));
			const at = new Date(Date.parse(now) + Math.round(seconds * 1000)).toISOString();
			await db.write({ text: `WITH ${log}, ${recheck('$1', '$6', '$7')} SELECT 1`, params: [...base, at, waits + 1] });
			announce(at);
		} else if (action === 'ignore') {
			// only the rows the decider saw; a row that arrived meanwhile has its own queued decision
			published((await db.write({ text: `WITH ${log}, gone AS (UPDATE sys_message m SET state = NULL, ambient = true
				WHERE conversation = $1 AND state = 'pending' AND id IN (SELECT jsonb_array_elements_text($6::jsonb)) RETURNING ${MSG}) SELECT r FROM gone`,
			params: [...base, JSON.stringify(pendingIds)] })).rows);
		} else {
			await db.write({ text: `WITH ${log} SELECT 1`, params: base });
		}
		await meter(cfg.metering, d, call);
		if (action === 'respond') await admit(conversation, envoy);
		return event;
	}
	async function hold(conversation: string, row: Q): Promise<readonly Row[]> {
		const n = row.params.length;
		const r = await db.write({ text: `WITH m AS (${row.text}), ${debounced(`$${n + 1}`, `$${n + 2}`)}
			SELECT m.*, (SELECT (extract(epoch FROM due_at) * 1000)::float8 FROM (SELECT due_at FROM held UNION ALL SELECT due_at FROM decision) d LIMIT 1) AS triage_due FROM m`,
		params: [...row.params, conversation, cfg.clock()] });
		const due = r.rows[0]?.['triage_due'];
		if (typeof due === 'number') announce(new Date(due).toISOString());
		published(r.rows);
		return r.rows.map(({ triage_due: _, ...rest }) => rest);
	}

	return {
		/** The in-app agent is triaged when the host binds the AI facility, unless the workspace declares `agent: { triage: false }`. */
		inApp: (): boolean => cfg.ai !== undefined && m.workspace.agent?.triage !== false,
		/** An envoy's message is triaged under its `scope` (default 'all'), unless the envoy declares `triage: false`. */
		envoy(spec: { readonly [k: string]: unknown }, group: boolean): boolean {
			const t = spec['triage'] as false | { scope?: 'dm' | 'group' | 'all' } | undefined;
			if (cfg.ai === undefined || t === false) return false;
			const scope = t?.scope ?? 'all';
			return scope === 'all' || scope === (group ? 'group' : 'dm');
		},
		/**
		 * Stores a triaged row as pending and queues its decision in the same statement. `row` is one data-modifying
		 * statement over `$1..$n` (it becomes the CTE `m`); the answer is `m`'s RETURNING rows.
		 */
		hold,
		/** An in-app plain-Enter post: stored pending with its decision queued (`sys_message.post` without `now`). */
		async post(o: { conversation: string; as: As; text: string; author: string; mode: 'agent' | 'plan'; files?: readonly Json[];
			/** The person's IANA zone (their clock, rule 57), kept on the row as an untriaged post keeps it. */ tz?: string }): Promise<{ id: string }> {
			const id = randomUUID(), files = JSON.stringify(o.files ?? []);
			await hold(o.conversation, { text: `INSERT INTO sys_message AS m (id, conversation, role, content, preview, text, state, mode, "as", author, created_at, files)
				VALUES ($1, $2, 'user', jsonb_strip_nulls(jsonb_build_object('text', $3::text, 'tz', $10::text)),
					$4, $3, 'pending', $5, $6::jsonb, $7, $8::timestamptz, $9::jsonb) RETURNING ${MSG}`,
			params: [id, o.conversation, o.text, preview(o.text), o.mode, JSON.stringify(o.as), o.author, cfg.clock(), files, o.tz ?? null] });
			return { id };
		},
			/** Deterministic trigger: every pending row is queued with it and the queued decision flushed (the caller queues its own row and drains). */
		release,
		/** `sys_conversation.respondNow`: the pending rows alone, admitted at once with no decision call. */
		admit,
		handlers: (): { readonly [name: string]: (input: Json) => Promise<Json> } => ({ [TRIAGE_RUN]: run }),
	};
}
export type Triage = ReturnType<typeof triage>;
