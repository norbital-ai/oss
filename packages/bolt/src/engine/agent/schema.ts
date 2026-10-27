// Conversations and messages (§5.9, rules 57–63): the transcript, the queue and an instance's message history are the same
// `sys_message` rows, the system models `src/system/data/model/+sys_{conversation,message}.model.ts`.
import { Effect, Option, Predicate, Schema, type Types } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { STUDIO_ROLES } from '../../protocol/schema.ts';
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
export type Plan = Types.Mutable<typeof PlanSchema.Type>;
/** The conversation's checklist (today's `todo`): unique ids, at most one `doing`, `done` is terminal with its text unchanged. */
export type Goal = Types.Mutable<typeof GoalSchema.Type>;
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
	/** The chat thread on that instance (a WhatsApp jid, a mail thread): where typing is shown. */
	thread: Schema.NullOr(Schema.String),
	parent: Schema.NullOr(Schema.String),
	status: Schema.Literals(['idle', 'running', 'stopped']),
	model: Schema.String,
	plan: Schema.NullOr(PlanSchema),
	goals: Schema.NullOr(Schema.Array(GoalSchema)),
	/** The automation run whose inference this is (its transcript, read-only). */
	run: Schema.optionalKey(Schema.NullOr(Schema.String))
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
export type ToolCall = Types.Mutable<typeof ToolCallSchema.Type>;
/** Rule 59: one per write outcome of a turn. */
export type Receipt = {
	outcome: 'committed' | 'pendingApproval';
	callable: string;
	records: readonly { model: string; id: string }[];
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
	records: Schema.Array(Schema.Struct({ model: Schema.String, id: Schema.String })),
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
/** Unnamed keys a content or file object carries stay as written. */
const Rest = [Schema.Record(Schema.String, Schema.Json)] as const;
/** A file a message carries or a step made (a FileRef `{ id, name, mime, bytes }`; no `id` when its bytes never arrived). */
export const FileRef = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.optionalKey(Schema.String),
		name: Schema.optionalKey(Schema.String),
		mime: Schema.optionalKey(Schema.String),
		bytes: Schema.optionalKey(Schema.Number),
		caption: Schema.optionalKey(Schema.String),
		text: Schema.optionalKey(Schema.String)
	}),
	Rest
);
export type FileRef = typeof FileRef.Type;
/**
 * A tool step's content (`role: 'tool'`): its call id and tool, the input as the panel shows it, the result once it
 * answered, the tool's Studio role and how long it ran.
 */
export const StepContent = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		args: Schema.optionalKey(Schema.String),
		result: Schema.optionalKey(Schema.Json),
		studio: Schema.optionalKey(Schema.String),
		ms: Schema.optionalKey(Schema.Number)
	}),
	Rest
);
/**
 * Every other row's content: a message's text and the zone it was sent from, a reply's reasoning and tool calls. An
 * inference's prompt is a bare string; an inbound row the agent never received has none.
 */
export const SaidContent = Schema.Union([
	Schema.Null,
	Schema.String,
	Schema.StructWithRest(
		Schema.Struct({
			text: Schema.optionalKey(Schema.String),
			tz: Schema.optionalKey(Schema.String),
			reasoning: Schema.optionalKey(Schema.String),
			toolCalls: Schema.optionalKey(Schema.Array(ToolCallSchema))
		}),
		Rest
	)
]);
const MessageFields = {
	id: Schema.String,
	conversation: Schema.String,
	seq: Schema.Number,
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
	files: Schema.optionalKey(Schema.Array(FileRef)),
	delivered_turn: Schema.optionalKey(Schema.NullOr(Schema.String)),
	direction: Schema.optionalKey(Schema.NullOr(Schema.String)),
	provider_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	reply_to: Schema.optionalKey(Schema.NullOr(Schema.String)),
	sent_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.optionalKey(Schema.String),
	invocation: Schema.optionalKey(Schema.NullOr(Schema.String)),
	email: Schema.optionalKey(Schema.Json),
	deleted_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	read_by: Schema.optionalKey(Schema.NullOr(Schema.String)),
	about: Schema.optionalKey(Schema.Json)
};
/** A `sys_message` row, its `content` decoded by `role`: a tool step, or what a person, the agent or the engine said. */
export const Message = Schema.Union([
	Schema.Struct({ ...MessageFields, role: Schema.Literal('tool'), content: StepContent }),
	Schema.Struct({
		...MessageFields,
		role: Schema.NullOr(Schema.Literals(['user', 'assistant', 'system'])),
		content: SaidContent
	})
]).annotate({ identifier: 'sys_message' });
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
		model: 'sys_message',
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
		model: 'sys_conversation',
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
	publicEnvoys: readonly string[] = [],
	admin = false
): boolean =>
	r !== null &&
	(r['parent'] ?? null) === null &&
	((r['run'] ?? null) !== null
		? admin
		: (r['integration'] ?? null) === null
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
	// an automation run's inference transcript: labelled by its title, read-only
	run: r['run'] ?? null,
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

const isStudio = Schema.is(StudioRoleSchema);
const isFileRef = Schema.is(FileRef);
/** The runs one `act` write started (`run`) and queued (`runs`); a write of another shape started none. */
const ranOf = Schema.decodeUnknownOption(
	Schema.Struct({
		run: Schema.optionalKey(Schema.String),
		runs: Schema.optionalKey(
			Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) }))
		)
	})
);
/**
 * What the panel reads of a step's result: its `error`, the `files` it stored or collected, the run a `wait` `settled`
 * (whose answer may be a file), a sub-agent's `conversation`, an `act`'s write (`results` only in transcripts from the retired write list), a
 * `preview` URL and a held `approval`. A result of any other shape shows none of them.
 */
const Outcome = Schema.Struct({
	results: Schema.optionalKey(Schema.Array(Schema.Json)),
	error: Schema.optionalKey(Schema.Json),
	files: Schema.optionalKey(Schema.Array(Schema.Json)),
	settled: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ result: Schema.optionalKey(Schema.Json) }))
	),
	conversation: Schema.optionalKey(Schema.String),
	preview: Schema.optionalKey(Schema.String),
	approval: Schema.optionalKey(Schema.Struct({ id: Schema.String }))
});
const outcomeOf = Schema.decodeUnknownOption(Outcome);
const NO_OUTCOME: typeof Outcome.Type = {};

/** Staff read a failed turn's reason (rule 59) and every instance's thread (§5.9). */
export const isStaff = (a: Authority) =>
	a.admin || (a.actor.kind === 'member' && !a.actor.external);
/**
 * A transcript row as the panel shows it: text, state, the held call of a confirmation card, a reply's receipts; `null`
 * for a row the panel leaves out (a cancelled input, and outside an instance's thread an ambient row no member posted).
 */
export function transcriptRow(r: MessageRow, staff: boolean, thread: boolean): AgentRow | null {
	if ((!thread && ambient(r) && r.as === null) || r.state === 'cancelled') return null;
	// every message that came in is shown: one admission left unanswered (chatter, an unknown sender, over a limit) is an aside
	const aside = r.role === null && r.direction === 'inbound';
	if (aside && !thread) return null;
	const meta = r.meta,
		step = r.role === 'tool' ? r.content : null,
		said = r.role !== 'tool' && typeof r.content === 'object' ? r.content : null,
		outcome =
			step === null ? NO_OUTCOME : Option.getOrElse(outcomeOf(step.result), () => NO_OUTCOME);
	// a tool step offers the files it stored or collected: a document's or sandbox output's `files`, and the file a
	// finished run answered (an export collected with `wait`), itself or under a key (`{ file }`)
	const answer = outcome.settled?.result,
		ran = Predicate.isObject(answer) ? [answer, ...Object.values(answer)] : [],
		offered: readonly unknown[] = outcome.files ?? ran,
		made = offered.filter(
			(f): f is FileRef => isFileRef(f) && f.id !== undefined && f.mime !== undefined
		),
		files = r.files !== undefined && r.files.length > 0 ? r.files : made;
	// a `spawn` answers its conversation; an `act` the runs it started, one write or `results` of them
	const child = step?.name === 'subagent' ? outcome.conversation : undefined;
	const runs =
		step?.name === 'act'
			? [
					...new Set(
						[step.result, ...(outcome.results ?? [])]
							.flatMap((o) => Option.toArray(ranOf(o)))
							.flatMap((o) => [o.run, ...(o.runs ?? []).map((x) => x.run)])
							.filter((x): x is string => x !== undefined)
					)
				]
			: [];
	const role = step?.studio,
		studio = isStudio(role) ? role : undefined,
		about =
			step !== null && (studio !== undefined || step.name === 'preview_show')
				? aboutOf(Predicate.isObject(step.result) ? step.result : {})
				: undefined,
		// a live change the host holds for the person (`approval.decide`): its id, never clipped
		approval = outcome.approval?.id;
	return {
		id: r.id,
		seq: Number(r.seq),
		role: aside ? 'user' : r.role,
		text: r.text,
		state: r.state,
		tag: meta?.tag ?? (ambient(r) || aside ? 'ambient' : null),
		...(r.turn === null ? {} : { turn: r.turn }),
		author: authorOf(r),
		...(r.created_at === undefined ? {} : { at: r.created_at }),
		...(r.about === undefined || r.about === null ? {} : { about: r.about }),
		...(files.length === 0
			? {}
			: {
					files: files.map((f) => ({
						...(f.id === undefined ? {} : { id: f.id }),
						name: f.name ?? 'file',
						mime: f.mime ?? ''
					}))
				}),
		...(staff && meta?.tag === 'failed' && meta.detail !== undefined
			? { detail: meta.detail }
			: {}), // hook:agent-ui — rule 59: the reason reaches staff, never a sender
		...(meta?.tag === 'confirm'
			? {
					call: { name: meta.call.name, input: meta.call.input }
				}
			: {}),
		// a confirmation card once settled (state cleared) is a step like any other: its outcome shows outside the fold
		...(step !== null && (meta?.tag !== 'confirm' || r.state === null)
			? {
					tool: {
						name: step.name,
						failed: outcome.error !== undefined,
						...(child === undefined ? {} : { child }),
						...(runs.length === 0 ? {} : { runs }),
						...(r.state === 'running' ? { running: true } : {}),
						...(step.args === undefined ? {} : { args: step.args }),
						...(step.result === undefined
							? {}
							: { result: clip(step.result, studio === 'logs' ? 20000 : 600) }),
						...(outcome.preview === undefined ? {} : { preview: outcome.preview }),
						...(approval === undefined ? {} : { approval }),
						...(about === undefined ? {} : { about }),
						...(studio === undefined ? {} : { studio }),
						...(step.ms === undefined ? {} : { ms: step.ms })
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
		...(r.role === 'assistant' && said?.reasoning !== undefined && said.reasoning !== ''
			? { reasoning: said.reasoning }
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
