// Conversations and messages (§5.9, rules 57–63): the transcript, the queue and the channel history are the same
// `sys_message` rows, the system models `src/system/data/model/sys_{conversation,message}/+model.ts`.
import type { Json } from '../../decl/values.ts';
import type { AgentRow } from '../../protocol/wire.ts';
import type { Authority, Captured, RowData } from '../contracts.ts';

/**
 * Whose authority a message carries (rules 57, 60, 63a): resolved per message, so each steer acts as its own sender.
 * `envoy` is a channel sender (P32): `member` the linked member, if any; `dm` whether their authority joins the envoy's.
 * `policies` is an automation's declared set; a sub-agent copies its parent's `as`, never wider.
 */
/** `team`: posted while previewing that team (rule 39): the turn holds the team's grants, as the request did. */
export type As = { member: string; team?: string } | { envoy: { name: string; channel: string; sender: string; member: string | null; dm: boolean } } | { policies: readonly string[]; run: string };

/** `verdicts` counts incomplete verdicts; the verifier runs again after each, with no stall (rule 63a, today's behaviour). */
export type Plan = { revision: number; body: string; status: 'draft' | 'active' | 'verified'; checkpoint: number; verdicts: number };
/** The conversation's checklist (today's `todo`): unique ids, at most one `doing`, `done` is terminal with its text unchanged. */
export type Goal = { id: string; text: string; status: 'pending' | 'doing' | 'done' };
export type ConversationRow = {
	id: string; title: string | null; owner: string | null; envoy: string | null; channel: string | null;
	parent: string | null; status: 'idle' | 'running' | 'stopped'; model: string; plan: Plan | null; goals: Goal[] | null;
};
/** What a row is beyond its role; absent on ordinary messages. */
export type Meta =
	| { tag: 'ambient' }
	| { tag: 'cut'; continuation?: string }
	/** `origin` (L-BOLT-546): `/compact` (manual), the agent's `compact` tool (requested) or the window (automatic). */
	| { tag: 'compact'; cutoff: number; keep: readonly string[]; origin?: 'manual' | 'requested' | 'automatic' }
	| { tag: 'verdict'; complete: boolean; gaps: readonly string[] }
	| { tag: 'confirm'; call: ToolCall }
	| { tag: 'reply'; receipts: readonly Receipt[]; usage?: Usage }
	| { tag: 'failed'; code: string; detail?: string; usage?: Usage }
	/** A tool row whose result was clipped keeps the whole output for `read_output` (rule 62). */
	| { tag: 'output'; full: Json }
	| { tag: 'note' };
/** Every model call of a turn summed (turn steps, compaction, verifier, awaited children): the cost disclosure's data. */
export type Usage = { input: number; output: number; calls: number; cost?: number;
	/** On a reply: the last model call's input tokens (the context it filled) and the model's window (the panel's context meter). */ context?: number; window?: number;
	/** On a reply: the model class that wrote it (the panel's model-change divider, L-BOLT-547). */ model?: string };
export type ToolCall = { id: string; name: string; input: Json; invalid?: string };
/** Rule 59: one per write outcome of a turn. */
export type Receipt = { outcome: 'committed' | 'pendingApproval'; callable: string; records: readonly { collection: string; id: string }[]; requestId?: string };
export type MessageRow = {
	/** `role` is null on a channel row no agent wrote or admitted (outbox, unadmitted inbound). */
	id: string; conversation: string; seq: number; role: 'user' | 'assistant' | 'tool' | 'system' | null; content: Json; text: string | null;
	/** hook:triage: 'pending' awaits a decision (rule 60a). `streaming`: a reply still being written; `running`: a tool call still running. */
	state: 'pending' | 'queued' | 'consumed' | 'cancelled' | 'confirm' | 'streaming' | 'running' | null; mode: 'agent' | 'plan' | 'compact' | null; as: As | null; author: string | null;
	meta: Meta | null; supersedes: string | null; turn: string | null;
	/** The channels area's columns, read when present: an unaddressed group message is ambient (rule 60). */
	addressed?: boolean | null; sender?: string | null; sender_name?: string | null; files?: Json;
	delivered_turn?: string | null; ambient?: boolean; // hook:triage
	provider_id?: string | null; sent_at?: string | null; created_at?: string; invocation?: string | null; email?: Json; deleted_at?: string | null; read_by?: string | null;
	about?: Json; // hook:agent-ui — `sys_message.file`
};
export const ambient = (r: MessageRow): boolean => r.meta?.tag === 'ambient' || r.addressed === false || r.ambient === true; // hook:triage
/** Who wrote a row, for the transcript and `read_messages`. */
export const authorOf = (r: MessageRow): string | null => r.author ?? r.sender_name ?? r.sender ?? null;

/** Rule list previews: at most 2 KiB of the text, cut on a character boundary. */
export function preview(text: string): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= 2048) return text;
	return new TextDecoder().decode(bytes.slice(0, 2045)).replace(/\uFFFD+$/, '') + '...';
}

/** Whole rows as JSON (`FROM sys_message m`): the channels area's columns (addressed, sender) ride along when they exist. */
export const MSG = `(to_jsonb(m) - 'preview') AS r`;
export const rowsOf = (rows: readonly { readonly [c: string]: Json }[]) => rows.map((x) => x['r'] as unknown as MessageRow);
/** Rule 65 for the transcript: the rows a statement wrote (its `RETURNING ${MSG}`) as the live lane's commit record. */
export const messageCommit = (rows: readonly MessageRow[], deleted = false): Captured[] =>
	rows.map((r) => ({ collection: 'sys_message', id: r.id, op: deleted ? 'delete' : 'update', revision: 0, old: deleted ? r as unknown as RowData : null, new: deleted ? null : r as unknown as RowData, cause: 'direct' }));
/** The same for `sys_conversation` (`RETURNING to_jsonb(c) AS r`): the panel's conversation list and each one's status, plan and goals. */
export const conversationCommit = (rows: readonly RowData[]): Captured[] =>
	rows.map((r) => ({ collection: 'sys_conversation', id: String(r['id']), op: 'update', revision: 0, old: null, new: r, cause: 'direct' }));
/** The panel's conversation list: a member's own in-app conversations, most recently active first. */
export const CONVERSATIONS = 100;
export const listed = (r: RowData | null, member: string): boolean => r !== null && r['owner'] === member && (r['channel'] ?? null) === null && (r['parent'] ?? null) === null;
/** A `sys_conversation` image as the list shows it, so a live patch matches a re-read. */
export const conversationRow = (r: RowData): { [k: string]: Json } => ({ id: r['id']!, title: r['title'] ?? null, at: r['updated_at']!, status: r['status']!,
	model: r['model']!, plan: r['plan'] ?? null, goals: r['goals'] ?? null });
/** A tool step's input or result as the panel shows it: at most 600 characters (the whole stays on the row for `read_output`). */
export const clip = (v: Json | undefined): string => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? null); return s.length <= 600 ? s : `${s.slice(0, 599)}…`; };

/** Staff read a failed turn's reason (rule 59) and every channel thread (§5.9). */
export const isStaff = (a: Authority) => a.admin || (a.actor.kind === 'member' && !a.actor.external);
/**
 * A transcript row as the panel shows it: text, state, the held call of a confirmation card, a reply's receipts; `null`
 * for a row the panel leaves out (a cancelled input, and outside a channel thread what the agent never received).
 */
export function transcriptRow(r: MessageRow, staff: boolean, thread: boolean): AgentRow | null {
	const meta = r.meta, step = (r.content ?? {}) as { name?: Json; result?: Json; reasoning?: Json; args?: Json; ms?: Json }, files = Array.isArray(r.files) ? r.files : [];
	const child = step.name === 'subagent' ? (step.result as { conversation?: Json } | null)?.conversation : undefined; // a `spawn` answers its conversation
	if ((!thread && meta?.tag === 'ambient') || r.state === 'cancelled') return null;
	return { id: r.id, seq: Number(r.seq), role: r.role, text: r.text, state: r.state, tag: meta?.tag ?? (r.ambient === true || r.addressed === false ? 'ambient' : null),
		author: authorOf(r), ...(r.created_at === undefined ? {} : { at: r.created_at }), ...(r.about === undefined || r.about === null ? {} : { about: r.about }),
		...(files.length === 0 ? {} : { files: files.map((f) => { const x = f as { id?: Json; name?: Json; fileName?: Json; mime?: Json; mimeType?: Json }; // hook:attachments
			return { ...(typeof x.id === 'string' ? { id: x.id } : {}), name: String(x.name ?? x.fileName ?? 'file'), mime: String(x.mime ?? x.mimeType ?? '') }; }) }),
		...(staff && meta?.tag === 'failed' && meta.detail !== undefined ? { detail: meta.detail } : {}), // hook:agent-ui — rule 59: the reason reaches staff, never a sender
		...(meta?.tag === 'confirm' ? { call: { name: meta.call.name, input: meta.call.input } } : {}),
		...(r.role === 'tool' && meta?.tag !== 'confirm' ? { tool: { name: String(step.name ?? 'tool'), failed: typeof step.result === 'object' && step.result !== null && !Array.isArray(step.result) && 'error' in step.result,
			...(typeof child === 'string' ? { child } : {}), ...(r.state === 'running' ? { running: true } : {}), ...(typeof step.args === 'string' ? { args: step.args } : {}),
			...(step.result === undefined ? {} : { result: clip(step.result) }), ...(typeof step.ms === 'number' ? { ms: step.ms } : {}) } } : {}),
		...(meta?.tag === 'reply' ? { receipts: meta.receipts as unknown as Json } : {}),
		...(r.role === 'assistant' && typeof step.reasoning === 'string' && step.reasoning !== '' ? { reasoning: step.reasoning } : {}), // L-BOLT-548
		...(meta?.tag === 'compact' ? { compact: { cutoff: meta.cutoff, keep: [...meta.keep], origin: meta.origin ?? 'automatic' } } : {}), // L-BOLT-546
		...((meta?.tag === 'reply' || meta?.tag === 'failed') && meta.usage !== undefined ? { usage: meta.usage as unknown as Json } : {}) }; // hook:agent — cost and context display
}
