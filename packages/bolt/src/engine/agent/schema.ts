// Conversations and messages: the transcript, the queue and an instance's message history are the same
// `sys_message` rows. Each system model lives under `src/system/data/model/<name>/+model.ts`.
import { Effect, Option, Predicate, Schema, type Types } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { STUDIO_ROLES, storedInstant, ToolBehavior } from '@norbital-ai/host-api';
import { AgentQuestion, PageAction, PageResult, Usage as UsageSchema } from '../../protocol/schema.ts';
import type { Json } from '../../decl/values.ts';
import type { AgentRow } from '../../protocol/wire.ts';
import type { Authority, RowData } from '../contracts.ts';

/** Plain words from a message or provider reply. */
export const textOf = (content: Json): string => {
	if (typeof content === 'string') return content;
	const t = Predicate.isObject(content) ? content['text'] : undefined;
	return typeof t === 'string' ? t : JSON.stringify(content);
};

/**
 * Whose authority a message carries: resolved per message, so each steer acts as its own sender.
 * `team`: posted while previewing that team: the turn holds the team's grants, as the request did.
 * `envoy` is a sender on an envoy's instance: `member` the linked member, if any; `dm` whether it is a direct message.
 * `policies` is an automation's declared set; a sub-agent copies its parent's `as`, never wider.
 */
export type As = typeof AsSchema.Type;

/** `verdicts` counts verifier passes: an executed plan is verified once. */
export type Plan = Types.Mutable<typeof PlanSchema.Type>;
const PlanSchema = Schema.Struct({
	revision: Schema.Number,
	body: Schema.String,
	status: Schema.Literals(['draft', 'active', 'verified']),
	checkpoint: Schema.Number,
	verdicts: Schema.Number
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
	/** The automation run whose inference this is (its transcript, read-only). */
	run: Schema.optionalKey(Schema.NullOr(Schema.String))
}).annotate({ identifier: 'sys_conversation' });
export type ConversationRow = typeof Conversation.Type;
/** What a row is beyond its role; absent on ordinary messages. */
export type Meta = typeof MetaSchema.Type;
/** Every model call of a turn summed (turn steps, compaction, verifier, awaited children): the cost disclosure's data. */
export type Usage = {
	-readonly [K in keyof typeof UsageSchema.Type]: (typeof UsageSchema.Type)[K];
};
export type ToolCall = Types.Mutable<typeof ToolCallSchema.Type>;
/** Rule 59: one per write outcome of a turn. */
export type Receipt = typeof ReceiptSchema.Type;
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
const AssistantSegment = Schema.Struct({
	text: Schema.String,
	reasoning: Schema.optionalKey(Schema.String),
	toolCalls: Schema.optionalKey(Schema.Array(ToolCallSchema))
});
export type AssistantSegment = typeof AssistantSegment.Type;
const ReceiptSchema = Schema.Struct({
	outcome: Schema.Literals(['committed', 'pending_approval']),
	callable: Schema.String,
	records: Schema.Array(Schema.Struct({ model: Schema.String, id: Schema.String })),
	request_id: Schema.optionalKey(Schema.String)
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
	Schema.Struct({ tag: Schema.Literal('confirm'), call: ToolCallSchema, full: Schema.optionalKey(Schema.Json) }),
	Schema.Struct({
		tag: Schema.Literal('reply'),
		receipts: Schema.Array(ReceiptSchema),
		question: Schema.optionalKey(AgentQuestion),
		answered: Schema.optionalKey(Schema.Literal(true)),
		/** A question to the person, or to the sub-agent's delegating agent. */
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
	Schema.Struct({
		tag: Schema.Literal('note'),
		/**
		 * A catalogue note's state (`catalogueNote`): the index it brought the conversation to, and on the first after a
		 * checkpoint the MCP tools the conversation's tool list then froze.
		 */
		catalogue: Schema.optionalKey(
			Schema.Struct({
				index: Schema.Record(Schema.String, Schema.String),
				native: Schema.optionalKey(
					Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String, input: Schema.Json }))
				)
			})
		)
	}),
	Schema.Struct({ tag: Schema.Literal('answer'), question: Schema.String }),
	Schema.Struct({ tag: Schema.Literal('aside'), message: Schema.String }),
	Schema.Struct({ tag: Schema.Literal('event'), at: Schema.String }),
	Schema.Struct({ tag: Schema.Literal('scheduled'), at: Schema.optionalKey(Schema.String) })
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
		sha256: Schema.optionalKey(Schema.String),
		caption: Schema.optionalKey(Schema.String),
		text: Schema.optionalKey(Schema.String)
	}),
	Rest
);
export type FileRef = typeof FileRef.Type;
/**
 * A tool step retains its protocol name and arguments. A native display projection names the host operation for the
 * panel; its result, declared Studio role and elapsed time stay on the same row.
 */
const ToolResultFields = {
		id: Schema.String,
		name: Schema.String,
		behavior: Schema.optionalKey(ToolBehavior),
		args: Schema.optionalKey(Schema.String),
		display: Schema.optionalKey(Schema.Struct({ name: Schema.String, args: Schema.String })),
		result: Schema.optionalKey(Schema.Json),
		studio: Schema.optionalKey(Schema.String),
		ms: Schema.optionalKey(Schema.Number)
};
export const StepContent = Schema.StructWithRest(Schema.Struct(ToolResultFields), Rest);
const StoredToolContent = Schema.StructWithRest(Schema.Struct({ ...ToolResultFields, assistant: Schema.String }), Rest);
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
			toolCalls: Schema.optionalKey(Schema.Array(ToolCallSchema)),
			segments: Schema.optionalKey(Schema.Array(AssistantSegment).check(Schema.isMinLength(1)))
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
			'scheduled',
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
	copied_from: Schema.optionalKey(Schema.NullOr(Schema.String)),
	turn: Schema.NullOr(Schema.String),
	addressed: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	sender: Schema.optionalKey(Schema.NullOr(Schema.String)),
	sender_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	files: Schema.optionalKey(Schema.Array(FileRef)),
	delivered_turn: Schema.optionalKey(Schema.NullOr(Schema.String)),
	direction: Schema.optionalKey(Schema.NullOr(Schema.String)),
	status: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
	Schema.Struct({ ...MessageFields, role: Schema.Literal('tool'), content: StoredToolContent }),
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
/** The panel's conversation list: a member's own in-app conversations, most recently active first. */
export const CONVERSATIONS = 100;
/**
 * Whether a `sys_conversation` image belongs to the member's own list — the same set the `conversations` read
 * returns, so a live patch never carries a row a re-read would not. An instance's thread has no owner (`conversations/index.ts`
 * inserts it without one), so channel visibility requires the read's runtime envoy or participant check.
 */
export const listed = (r: RowData | null, member: string, admin = false): boolean =>
	r !== null &&
	(r['parent'] ?? null) === null &&
	((r['run'] ?? null) !== null
		? admin
		: (r['integration'] ?? null) === null && r['owner'] === member);
/** SQL visibility of a public envoy's conversation, using the reader's `c` alias. */
export const PUBLIC_ENVOY = `EXISTS (SELECT 1 FROM sys_envoy e WHERE e.id::text = c.envoy AND e.active AND e.audience = 'public')`;
/**
 * Which conversations other than a member's own a reader may see (`c` the `sys_conversation` row; each value a SQL
 * placeholder): an automation's transcript for an administrator, an envoy's channel thread for staff when the envoy is
 * public, or for anyone who posted in it. Opening one (`conversationFor`) and listing them (the `conversations` read) share it.
 */
export const sharedConversations = (p: {
	readonly member: string;
	readonly admin: string;
	readonly staff: string;
}) => `(c.run IS NOT NULL AND ${p.admin}) OR
   (c.integration IS NOT NULL AND ${p.member} IS NOT NULL AND ((${p.staff} AND ${PUBLIC_ENVOY}) OR
    EXISTS (SELECT 1 FROM sys_message m WHERE m.conversation = c.id AND ${p.member} IN (m.author, m."as"->>'member', m."as"->'envoy'->>'member'))))`;
export const ConversationListRow = Schema.Struct({
	id: Schema.String,
	updated_at: Schema.String,
	status: Schema.String,
	model: Schema.String,
	title: Schema.optionalKey(Schema.NullOr(Schema.String)),
	plan: Schema.optionalKey(Schema.Json),
	envoy: Schema.optionalKey(Schema.NullOr(Schema.String)),
	integration: Schema.optionalKey(Schema.NullOr(Schema.String)),
	run: Schema.optionalKey(Schema.NullOr(Schema.String)),
	kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
	thread: Schema.optionalKey(Schema.NullOr(Schema.String)),
	peer: Schema.optionalKey(Schema.NullOr(Schema.String)),
	archived_at: Schema.optionalKey(Schema.NullOr(Schema.String))
});
/** Reads and capture projection decode the same native list row. */
export const conversationRow = (r: typeof ConversationListRow.Type): { [k: string]: Json } => ({
	id: r['id'],
	title: r['title'] ?? null,
	at: storedInstant(r['updated_at']),
	status: r['status'],
	model: r['model'],
	plan: r['plan'] ?? null,
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
	peer: r['peer'] ?? null,
	// archived by its owner: a live list drops it, the archived list shows it
	archived: r['archived_at'] != null
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

const SourceEdit = Schema.fromJsonString(
	Schema.Struct({
		path: Schema.String,
		content: Schema.optionalKey(Schema.String),
		old_string: Schema.optionalKey(Schema.String),
		new_string: Schema.optionalKey(Schema.String)
	})
);
const marked = (mark: string, text: string) =>
	text
		.split('\n')
		.map((line) => `${mark}${line}`)
		.join('\n');
/**
 * A source edit's files and compact diffs for the panel's Changes tab. An edit reads them off its call, whose answer
 * stays `{ path, diagnostics }` so a diff never enters the model's context.
 */
function changesOf(
	step: { readonly name: string; readonly args?: string } | null
): ReadonlyArray<{ path: string; diff: string; change?: string }> | undefined {
	if (step === null) return undefined;
	const edit =
		step.name === 'workspace_edit' || step.name === 'workspace_write'
			? Option.getOrUndefined(Schema.decodeUnknownOption(SourceEdit)(step.args))
			: undefined;
	if (edit?.content !== undefined)
		return [{ path: edit.path, diff: marked('+', edit.content).slice(0, 8000) }];
	if (edit?.old_string !== undefined && edit.new_string !== undefined)
		return [
			{
				path: edit.path,
				diff: `${marked('-', edit.old_string)}\n${marked('+', edit.new_string)}`.slice(0, 8000)
			}
		];
	return undefined;
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
		Schema.NullOr(
			Schema.Struct({
				result: Schema.optionalKey(Schema.Json),
				studio: Schema.optionalKey(StudioRoleSchema)
			})
		)
	),
	conversation: Schema.optionalKey(Schema.String),
	preview: Schema.optionalKey(Schema.String),
	navigation: Schema.optionalKey(Schema.String),
	page: Schema.optionalKey(PageAction),
	page_result: Schema.optionalKey(PageResult),
	approval: Schema.optionalKey(Schema.Struct({ id: Schema.String }))
});
const outcomeOf = Schema.decodeUnknownOption(Outcome);
const NO_OUTCOME: typeof Outcome.Type = {};

/**
 * A value as PostgreSQL holds it, before anything sees it: text and jsonb have no NUL, and a tool's text can carry one (a
 * binary file read as text), which would otherwise end the turn. Every NUL in a string or key becomes U+FFFD.
 */
export function storable(value: string): string;
export function storable(value: Json): Json;
export function storable(value: Json): Json {
	return JSON.stringify(value).includes('\\u0000') ? scrub(value) : value;
}
const scrub = (value: Json): Json =>
	typeof value === 'string'
		? value.replaceAll('\0', '\ufffd')
		: value === null || typeof value !== 'object'
			? value
			: Array.isArray(value)
				? value.map(scrub)
				: Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replaceAll('\0', '\ufffd'), scrub(v)]));
/** Staff read a failed turn's reason and every instance's thread. */
export const isStaff = (a: Authority) =>
	a.admin || (a.actor.kind === 'member' && !a.actor.external);
/**
 * A transcript row as the panel shows it: text, state, the held call of a confirmation card, a reply's receipts; `null`
 * for a row the panel leaves out (a cancelled input, and outside an instance's thread an ambient row no member posted).
 */
export function transcriptRow(r: MessageRow, staff: boolean, thread: boolean): AgentRow | null {
	if (r.meta?.tag === 'aside') return null;
	if ((!thread && ambient(r) && r.as === null) || r.state === 'cancelled') return null;
	// every message that came in is shown: one admission left unanswered (chatter, an unknown sender, over a limit) is an aside
	const aside = r.role === null && r.direction === 'inbound';
	if (aside && !thread) return null;
	const meta = r.meta,
		step = r.role === 'tool' ? { ...r.content, ...r.content.display, result: r.content['approval_result'] ?? r.content.result } : null,
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
	// Only `wait` can relay a host job's trusted role; an ordinary tool's data cannot create a preview.
	const collected = step?.name === 'wait' ? outcome.settled : undefined,
		payload = collected?.studio === undefined ? step?.result : collected.result,
		completed =
			collected?.studio === undefined
				? outcome
				: Option.getOrElse(outcomeOf(payload), () => NO_OUTCOME),
		role = step?.studio ?? collected?.studio,
		studio = isStudio(role) ? role : undefined,
		about =
			step !== null && (studio !== undefined || outcome.preview !== undefined)
				? aboutOf(Predicate.isObject(payload) ? payload : {})
				: undefined,
		// a live change the host holds for the person (`approval.decide`): its id, never clipped
		approval = outcome.approval?.id,
		// a source edit's compact diffs, kept whole for the panel while the result itself may be clipped
		changes = changesOf(step);
	return {
		id: r.id,
		seq: Number(r.seq),
		role: aside ? 'user' : r.role === null && r.direction === 'outbound' ? 'assistant' : r.role,
		text: r.text,
		state: r.state,
		tag: meta?.tag ?? (ambient(r) || aside ? 'ambient' : null),
		...(meta?.tag === 'scheduled' && meta.at !== undefined ? { due: meta.at } : {}),
		...(r.turn === null ? {} : { turn: r.turn }),
		author: authorOf(r),
		...(r.created_at === undefined ? {} : { at: storedInstant(r.created_at) }),
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
			: {}), // hook:agent-ui — the reason reaches staff, never a sender
		...(r.copied_from == null && meta?.tag === 'confirm'
			? {
					call: { name: meta.call.name, input: meta.call.input }
				}
			: {}),
		// a confirmation card once settled (state cleared) is a step like any other: its outcome shows outside the fold
		...(step !== null && (meta?.tag !== 'confirm' || r.state === null)
			? {
					tool: {
						name: step.name,
						behavior: step.behavior ?? {},
						failed: completed.error !== undefined && completed.error !== null,
						...(r.copied_from != null || child === undefined ? {} : { child }),
						...(r.copied_from != null || runs.length === 0 ? {} : { runs }),
						...(r.state === 'running' ? { running: true } : {}),
						...(step.args === undefined ? {} : { args: step.args }),
						...(step.result === undefined
							? {}
							: {
									result: clip(step.result, studio === 'logs' || step.behavior?.data === true ? 20000 : 600)
								}),
						...(completed.preview === undefined ? {} : { preview: completed.preview }),
						...(r.copied_from != null || approval === undefined ? {} : { approval }),
						...(r.copied_from == null && step.behavior?.page === true && outcome.navigation !== undefined
							? { navigation: outcome.navigation }
							: {}),
						...(r.copied_from == null && step.behavior?.page === true && outcome.page !== undefined ? { page: outcome.page } : {}),
						...(r.copied_from == null && step.behavior?.page === true && outcome.page_result !== undefined
							? { page_result: outcome.page_result }
							: {}),
						...(about === undefined ? {} : { about }),
						...(changes === undefined ? {} : { changes }),
						...(studio === undefined ? {} : { studio }),
						...(step.ms === undefined ? {} : { ms: step.ms })
					}
				}
			: {}),
		...(meta?.tag === 'reply' ? { receipts: meta.receipts } : {}),
		...(r.copied_from == null && meta?.tag === 'reply' && meta.asked === true ? { asked: true as const } : {}),
		...(r.copied_from == null && meta?.tag === 'reply' && meta.question !== undefined ? { question: meta.question } : {}),
		...(r.copied_from == null && meta?.tag === 'reply' && meta.answered !== undefined ? { answered: meta.answered } : {}),
		...(meta?.tag === 'answer' ? { answer_to: meta.question } : {}),
		...(r.copied_from == null && meta?.tag === 'report'
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
		...(r.copied_from == null && (meta?.tag === 'reply' || meta?.tag === 'failed') && meta.usage !== undefined
			? { usage: meta.usage }
			: {})
	}; // hook:agent — cost and context display
}

export class AgentRefusal extends Schema.TaggedError<AgentRefusal>()('AgentRefusal', {
	message: Schema.String
}) {}
