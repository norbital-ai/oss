// Conversations and messages (§5.9, rules 57–63): the transcript, the queue and an instance's message history are the same
// `sys_message` rows, the system models `src/system/data/model/+sys_{conversation,message}.model.ts`.
import { Effect, Predicate, Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { STUDIO_PHASES, STUDIO_ROLES } from '../../protocol/schema.ts';
import { Usage as UsageSchema } from '../../protocol/schema.ts';
import type { Json } from '../../decl/values.ts';
import type { AgentRow } from '../../protocol/wire.ts';
import type { Authority, Captured, RowData } from '../contracts.ts';

/**
 * Whose authority a message carries (rules 57, 60, 63a): resolved per message, so each steer acts as its own sender.
 * `team`: posted while previewing that team (rule 39): the turn holds the team's grants, as the request did.
 * `envoy` is a sender on an envoy's instance (P32): `member` the linked member, if any; `dm` whether it is a direct message.
 * `policies` is an automation's declared set; a sub-agent copies its parent's `as`, never wider.
 */
export type As =
	| { member: string; team?: string }
	| {
			envoy: { name: string; instance: string; sender: string; member: string | null; dm: boolean };
	  }
	| { policies: readonly string[]; run: string };

/** `verdicts` counts incomplete verdicts; the verifier runs again after each, with no stall (rule 63a, today's behaviour). */
export type Plan = {
	revision: number;
	body: string;
	status: 'draft' | 'active' | 'verified';
	checkpoint: number;
	verdicts: number;
};
/** The conversation's checklist (today's `todo`): unique ids, at most one `doing`, `done` is terminal with its text unchanged. */
export type Goal = { id: string; text: string; status: 'pending' | 'doing' | 'done' };
const PlanSchema = Schema.Struct({
	revision: Schema.Number,
	body: Schema.String,
	status: Schema.Literals(['draft', 'active', 'verified']),
	checkpoint: Schema.Number,
	verdicts: Schema.Number
});
const GoalSchema = Schema.Struct({
	id: Schema.String,
	text: Schema.String,
	status: Schema.Literals(['pending', 'doing', 'done'])
});
export const Conversation = Schema.Struct({
	id: Schema.String,
	title: Schema.NullOr(Schema.String),
	owner: Schema.NullOr(Schema.String),
	envoy: Schema.NullOr(Schema.String),
	integration: Schema.NullOr(Schema.String),
	parent: Schema.NullOr(Schema.String),
	status: Schema.Literals(['idle', 'running', 'stopped']),
	model: Schema.String,
	plan: Schema.NullOr(PlanSchema),
	goals: Schema.NullOr(Schema.Array(GoalSchema))
}).annotate({ identifier: 'sys_conversation' });
export type ConversationRow = typeof Conversation.Type;
/** What a row is beyond its role; absent on ordinary messages. */
export type Meta =
	| { tag: 'cut'; continuation?: string }
	/** `origin` (L-BOLT-546): `/compact` (manual), the agent's `compact` tool (requested) or the window (automatic). */
	| {
			tag: 'compact';
			cutoff: number;
			keep: readonly string[];
			origin?: 'manual' | 'requested' | 'automatic';
	  }
	| { tag: 'verdict'; complete: boolean; gaps: readonly string[] }
	| { tag: 'confirm'; call: ToolCall }
	| { tag: 'reply'; receipts: readonly Receipt[]; asked?: true; usage?: Usage }
	| { tag: 'failed'; code: string; detail?: string; usage?: Usage }
	/** A tool row whose result was clipped keeps the whole output for `read_output` (rule 62). */
	| { tag: 'output'; full: Json }
	| { tag: 'note' }
	/** A sub-agent's report to its parent (its answer, its question, a failure or a stop), queued as the parent's input. */
	| { tag: 'report'; conversation: string; asked?: true };
/** Every model call of a turn summed (turn steps, compaction, verifier, awaited children): the cost disclosure's data. */
export type Usage = {
	-readonly [K in keyof typeof UsageSchema.Type]: (typeof UsageSchema.Type)[K];
};
export type ToolCall = { id: string; name: string; input: Json; invalid?: string };
/** Rule 59: one per write outcome of a turn. */
export type Receipt = {
	outcome: 'committed' | 'pendingApproval';
	callable: string;
	records: readonly { collection: string; id: string }[];
	requestId?: string;
};
const AsSchema = Schema.Union([
	Schema.Struct({ member: Schema.String, team: Schema.optionalKey(Schema.String) }),
	Schema.Struct({
		envoy: Schema.Struct({
			name: Schema.String,
			instance: Schema.String,
			sender: Schema.String,
			member: Schema.NullOr(Schema.String),
			dm: Schema.Boolean
		})
	}),
	Schema.Struct({ policies: Schema.Array(Schema.String), run: Schema.String })
]);
const ToolCallSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	input: Schema.Json,
	invalid: Schema.optionalKey(Schema.String)
});
const ReceiptSchema = Schema.Struct({
	outcome: Schema.Literals(['committed', 'pendingApproval']),
	callable: Schema.String,
	records: Schema.Array(Schema.Struct({ collection: Schema.String, id: Schema.String })),
	requestId: Schema.optionalKey(Schema.String)
});
const MetaSchema = Schema.Union([
	Schema.Struct({
		tag: Schema.Literal('report'),
		conversation: Schema.String,
		asked: Schema.optionalKey(Schema.Literal(true))
	}),
	Schema.Struct({ tag: Schema.Literal('cut'), continuation: Schema.optionalKey(Schema.String) }),
	Schema.Struct({
		tag: Schema.Literal('compact'),
		cutoff: Schema.Number,
		keep: Schema.Array(Schema.String),
		origin: Schema.optionalKey(Schema.Literals(['manual', 'requested', 'automatic']))
	}),
	Schema.Struct({
		tag: Schema.Literal('verdict'),
		complete: Schema.Boolean,
		gaps: Schema.Array(Schema.String)
	}),
	Schema.Struct({ tag: Schema.Literal('confirm'), call: ToolCallSchema }),
	Schema.Struct({
		tag: Schema.Literal('reply'),
		receipts: Schema.Array(ReceiptSchema),
		/** A sub-agent's question to its delegating agent (`ask_parent`), not its answer. */
		asked: Schema.optionalKey(Schema.Literal(true)),
		usage: Schema.optionalKey(UsageSchema)
	}),
	Schema.Struct({
		tag: Schema.Literal('failed'),
		code: Schema.String,
		detail: Schema.optionalKey(Schema.String),
		usage: Schema.optionalKey(UsageSchema)
	}),
	Schema.Struct({ tag: Schema.Literal('output'), full: Schema.Json }),
	Schema.Struct({ tag: Schema.Literal('note') })
]);
export const Message = Schema.Struct({
	id: Schema.String,
	conversation: Schema.String,
	seq: Schema.Number,
	role: Schema.NullOr(Schema.Literals(['user', 'assistant', 'tool', 'system'])),
	content: Schema.Json,
	text: Schema.NullOr(Schema.String),
	state: Schema.NullOr(
		Schema.Literals([
			'pending',
			'queued',
			'consumed',
			'cancelled',
			'confirm',
			'approved',
			'streaming',
			'running'
		])
	),
	mode: Schema.NullOr(Schema.Literals(['agent', 'plan', 'compact'])),
	as: Schema.NullOr(AsSchema),
	author: Schema.NullOr(Schema.String),
	meta: Schema.NullOr(MetaSchema),
	supersedes: Schema.NullOr(Schema.String),
	turn: Schema.NullOr(Schema.String),
	addressed: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	sender: Schema.optionalKey(Schema.NullOr(Schema.String)),
	sender_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	files: Schema.optionalKey(Schema.Json),
	delivered_turn: Schema.optionalKey(Schema.NullOr(Schema.String)),
	provider_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	reply_to: Schema.optionalKey(Schema.NullOr(Schema.String)),
	sent_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.optionalKey(Schema.String),
	invocation: Schema.optionalKey(Schema.NullOr(Schema.String)),
	email: Schema.optionalKey(Schema.Json),
	deleted_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	read_by: Schema.optionalKey(Schema.NullOr(Schema.String)),
	about: Schema.optionalKey(Schema.Json)
}).annotate({ identifier: 'sys_message' });
export type MessageRow = typeof Message.Type;
export const ambient = (r: MessageRow): boolean => r.addressed === false;
/** Who wrote a row, for the transcript and `read_messages`. */
export const authorOf = (r: MessageRow): string | null =>
	r.author ?? r.sender_name ?? r.sender ?? null;

/** Decode the complete row image returned by the statement, retaining every typed transcript field. */
export const rowsOf = (rows: readonly { readonly [c: string]: Json }[]) =>
	Schema.decodeUnknownEffect(Schema.Array(Message))(rows.map((x) => x['r'])).pipe(
		Effect.mapError((error) =>
			BoltError.make('corrupt', 'decode', 'a sys_message row does not match its schema', error)
		)
	);
/** Rule 65 for the transcript: the rows a statement wrote (its `RETURNING ${MSG}`) as the live lane's commit record. */
export const messageCommit = (rows: readonly MessageRow[], deleted = false): Captured[] =>
	rows.map((r) => ({
		collection: 'sys_message',
		id: r.id,
		op: deleted ? 'delete' : 'update',
		revision: 0,
		old: deleted ? { ...r } : null,
		new: deleted ? null : { ...r },
		cause: 'direct'
	}));
/** The same for `sys_conversation` (`RETURNING to_jsonb(c) AS r`): the panel's conversation list and each one's status, plan and goals. */
export const conversationCommit = (rows: readonly RowData[]): Captured[] =>
	rows.map((r) => ({
		collection: 'sys_conversation',
		id: String(r['id']),
		op: 'update',
		revision: 0,
		old: null,
		new: r,
		cause: 'direct'
	}));
/** The panel's conversation list: a member's own in-app conversations, most recently active first. */
export const CONVERSATIONS = 100;
/**
 * Whether a `sys_conversation` image belongs to the member's own list (§5.9) — the same set the `conversations` read
 * returns, so a live patch never carries a row a re-read would not. An instance's thread has no owner (`conversations/index.ts`
 * inserts it without one), so it is admitted by the envoy being `public`: that arm is the one a row can answer alone.
 * A thread of a private envoy the member posted in is in the read but not here, so its conversations row is not patched;
 * its messages still are, through the transcript's own view.
 */
export const listed = (
	r: RowData | null,
	member: string,
	publicEnvoys: readonly string[] = []
): boolean =>
	r !== null &&
	(r['parent'] ?? null) === null &&
	((r['integration'] ?? null) === null
		? r['owner'] === member
		: publicEnvoys.includes(String(r['envoy'] ?? '')));
/** A `sys_conversation` image as the list shows it, so a live patch matches a re-read. */
export const conversationRow = (r: RowData): { [k: string]: Json } => ({
	id: r['id']!,
	title: r['title'] ?? null,
	at: r['updated_at']!,
	status: r['status']!,
	model: r['model']!,
	plan: r['plan'] ?? null,
	goals: r['goals'] ?? null,
	// which conversation this is, for the panel's segmented selector: an envoy's thread beside the member's own in-app
	// ones. `integration` (the instance) is null exactly when the conversation is the member's own.
	envoy: r['envoy'] ?? null,
	integration: r['integration'] ?? null,
	// an instance thread's own facts: a direct message or a group chat, and the provider's thread (the peer or the group)
	kind: r['integration'] == null ? null : (r['kind'] ?? null),
	thread: r['thread'] ?? null,
	// a DM's member, by name, when the sender is one: the selector reads "Dion (+65 9238 8112)"
	peer: r['peer'] ?? null
});
/** A tool step's input or result as the panel shows it: at most 600 characters (the whole stays on the row for `read_output`). */
export const clip = (v: Json | undefined, max = 600): string => {
	const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};
/** A step's declared Studio role (`HostTool.studio`), as the engine recorded it with the step. */
const StudioRoleSchema = Schema.Literals(STUDIO_ROLES);
const isPhase = Schema.is(Schema.Literals(STUDIO_PHASES));
/** What a Studio result says it shows, for the panel's caption: these facts, at its top level. */
const ABOUT = [
	'environment',
	'release',
	'commit',
	'message',
	'branch',
	'url',
	'viewport',
	'capturedAt'
] as const;
function aboutOf(result: { readonly [k: string]: unknown }): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const k of ABOUT) {
		const v = result[k];
		if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
		else if (
			Predicate.isObject(v) &&
			typeof v['width'] === 'number' &&
			typeof v['height'] === 'number'
		)
			out[k] = `${v['width']}×${v['height']}`;
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

/** Staff read a failed turn's reason (rule 59) and every instance's thread (§5.9). */
export const isStaff = (a: Authority) =>
	a.admin || (a.actor.kind === 'member' && !a.actor.external);
/**
 * A transcript row as the panel shows it: text, state, the held call of a confirmation card, a reply's receipts; `null`
 * for a row the panel leaves out (a cancelled input, and outside an instance's thread an ambient row no member posted).
 */
export function transcriptRow(r: MessageRow, staff: boolean, thread: boolean): AgentRow | null {
	const meta = r.meta,
		step: RowData = Schema.is(Schema.Record(Schema.String, Schema.Json))(r.content)
			? r.content
			: {},
		// a tool step offers the files it stored or collected: a document's or sandbox output's `files`, and the file a
		// finished run answered (an export collected with `wait`)
		result = r.role === 'tool' && Predicate.isObject(step.result) ? step.result : {},
		settled = Predicate.isObject(result['settled']) ? result['settled']['result'] : undefined,
		// a run answers its file itself or under a key (`{ file }`)
		ran = Predicate.isObject(settled) ? [settled, ...Object.values(settled)] : [],
		made = (Array.isArray(result['files']) ? result['files'] : ran).filter(
			(f) => Predicate.isObject(f) && typeof f['id'] === 'string' && typeof f['mime'] === 'string'
		),
		files = Array.isArray(r.files) && r.files.length > 0 ? r.files : made;
	const child =
		step.name === 'subagent'
			? Predicate.isObject(step.result)
				? step.result['conversation']
				: undefined
			: undefined; // a `spawn` answers its conversation
	// an `act` answers the run it started (`run`) and the runs its writes queued (`runs`), one write or `results` of them
	const runs =
		step.name === 'act' && Predicate.isObject(step.result)
			? [
					...new Set(
						[step.result, ...(Array.isArray(step.result['results']) ? step.result['results'] : [])]
							.filter(Predicate.isObject)
							.flatMap((o) => [
								o['run'],
								...(Array.isArray(o['runs'])
									? o['runs'].map((x) => (Predicate.isObject(x) ? x['run'] : undefined))
									: [])
							])
							.filter((x): x is string => typeof x === 'string')
					)
				]
			: [];
	const studio = Schema.is(StudioRoleSchema)(step.studio) ? step.studio : undefined,
		about = studio !== undefined || step.name === 'preview_show' ? aboutOf(result) : undefined;
	if ((!thread && ambient(r) && r.as === null) || r.state === 'cancelled') return null;
	return {
		id: r.id,
		seq: Number(r.seq),
		role: r.role,
		text: r.text,
		state: r.state,
		tag: meta?.tag ?? (ambient(r) ? 'ambient' : null),
		author: authorOf(r),
		...(r.created_at === undefined ? {} : { at: r.created_at }),
		...(r.about === undefined || r.about === null ? {} : { about: r.about }),
		...(files.length === 0
			? {}
			: {
					files: files.map((f) => {
						const x = Predicate.isObject(f) ? f : {};
						return {
							...(typeof x.id === 'string' ? { id: x.id } : {}),
							name: String(x.name ?? 'file'),
							mime: String(x.mime ?? '')
						};
					})
				}),
		...(staff && meta?.tag === 'failed' && meta.detail !== undefined
			? { detail: meta.detail }
			: {}), // hook:agent-ui — rule 59: the reason reaches staff, never a sender
		...(meta?.tag === 'confirm'
			? {
					call: {
						name: meta.call.name,
						input: meta.call.input,
						...(studio === undefined ? {} : { studio })
					}
				}
			: {}),
		...(r.state === 'approved' && isPhase(step.progress) ? { progress: step.progress } : {}),
		// a confirmation card once settled (state cleared) is a step like any other: its outcome shows outside the fold
		...(r.role === 'tool' && (meta?.tag !== 'confirm' || r.state === null)
			? {
					tool: {
						name: String(step.name ?? 'tool'),
						failed:
							typeof step.result === 'object' &&
							step.result !== null &&
							!Array.isArray(step.result) &&
							'error' in step.result,
						...(typeof child === 'string' ? { child } : {}),
						...(runs.length === 0 ? {} : { runs }),
						...(r.state === 'running' ? { running: true } : {}),
						...(typeof step.args === 'string' ? { args: step.args } : {}),
						...(step.result === undefined
							? {}
							: { result: clip(step.result, studio === 'logs' ? 20000 : 600) }),
						...(typeof result['preview'] === 'string' ? { preview: result['preview'] } : {}),
						...(about === undefined ? {} : { about }),
						...(studio === undefined ? {} : { studio }),
						...(typeof step.ms === 'number' ? { ms: step.ms } : {})
					}
				}
			: {}),
		...(meta?.tag === 'reply' ? { receipts: meta.receipts } : {}),
		...(meta?.tag === 'reply' && meta.asked === true ? { asked: true as const } : {}),
		...(meta?.tag === 'report'
			? {
					report: {
						conversation: meta.conversation,
						...(meta.asked === true ? { asked: true as const } : {})
					}
				}
			: {}),
		...(r.role === 'assistant' && typeof step.reasoning === 'string' && step.reasoning !== ''
			? { reasoning: step.reasoning }
			: {}), // L-BOLT-548
		...(meta?.tag === 'compact'
			? {
					compact: { cutoff: meta.cutoff, keep: [...meta.keep], origin: meta.origin ?? 'automatic' }
				}
			: {}), // L-BOLT-546
		...((meta?.tag === 'reply' || meta?.tag === 'failed') && meta.usage !== undefined
			? { usage: meta.usage }
			: {})
	}; // hook:agent — cost and context display
}

export class AgentRefusal extends Schema.TaggedError<AgentRefusal>()('AgentRefusal', {
	message: Schema.String
}) {}
