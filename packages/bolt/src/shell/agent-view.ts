// The agent panel's pure projections of its transcript rows: the orb's mark (L-BOLT-436), the context view (L-BOLT-546)
// and the model-change dividers (L-BOLT-547). Each is a function of the rows alone, so a reload shows the same thing.
import type { AgentConversation, AgentRow } from '../protocol/wire.ts';

/** One mark per state: waiting on a person is not failing, and a finished or stopped turn is not idle. */
export type Orb = 'ready' | 'working' | 'waiting' | 'failed' | 'done' | 'stopped';
/** Every mark's name (a `t()` key) and icon; `working` is the accretion disc. */
export const ORB: { readonly [o in Orb]: { label: string; icon: string } } = {
	ready: { label: 'Ready', icon: 'lucide:circle-dashed' },
	working: { label: 'Working…', icon: 'lucide:loader' },
	waiting: { label: 'Waiting for you', icon: 'lucide:hand' },
	failed: { label: 'Failed', icon: 'lucide:circle-alert' },
	done: { label: 'Done', icon: 'lucide:circle-check' },
	stopped: { label: 'Stopped', icon: 'lucide:circle-stop' },
};
/**
 * The conversation's mark. A caller's own knowledge wins: `failed` (a send it saw fail) over everything, `pending` (a
 * turn it just dispatched, before any status arrived) over the rows.
 */
export function orbState(o: { status: 'idle' | 'running' | 'stopped'; rows: readonly AgentRow[]; pending?: boolean; failed?: boolean }): Orb {
	if (o.failed === true) return 'failed';
	if (o.pending === true || o.status === 'running') return 'working';
	if (o.status === 'stopped') return 'stopped';
	if (o.rows.some((r) => r.state === 'confirm')) return 'waiting';
	const last = o.rows.findLast((r) => r.role === 'assistant');
	return last?.tag === 'failed' ? 'failed' : last?.tag === 'reply' ? 'done' : 'ready';
}

/**
 * What the model no longer reads: rows summarized into the latest checkpoint (not the ones it kept, and never input
 * still waiting or delivered after it), and the discussion before an executed plan. A draft plan moves nothing, so a
 * planning revision stays in view until its plan runs. `origin` is the checkpoint's own provenance. `history` is
 * staging's context segment: everything up to the boundary (kept rows too) and the checkpoint itself, shown behind the
 * segment's Transcript tab instead of in the conversation; `checkpoint` is the summary it shows, unless an executed
 * plan came after it.
 */
export function contextView(rows: readonly AgentRow[], plan: AgentConversation['plan'] | undefined): {
	outside: ReadonlySet<string>; history: ReadonlySet<string>; checkpoint: AgentRow | null; origin: 'manual' | 'requested' | 'automatic' | null } {
	const latest = rows.findLast((r) => r.compact !== undefined);
	const planAt = plan !== null && plan !== undefined && plan.status !== 'draft' ? plan.checkpoint : undefined;
	const checkpoint = latest !== undefined && (planAt === undefined || latest.seq > planAt) ? latest : null;
	const outside = new Set<string>(), history = new Set<string>();
	for (const r of rows) {
		if (r.state === 'queued' || r.state === 'pending') continue;
		const before = (latest?.compact !== undefined && r.seq <= latest.compact.cutoff) || (planAt !== undefined && r.seq <= planAt);
		if (before || r.id === checkpoint?.id) history.add(r.id);
		if (r.id === latest?.id) continue;
		const summarized = latest?.compact !== undefined && r.seq <= latest.compact.cutoff && !latest.compact.keep.includes(r.id);
		if (summarized || (planAt !== undefined && r.seq <= planAt)) outside.add(r.id);
	}
	return { outside, history, checkpoint, origin: latest?.compact?.origin ?? null };
}

/** A checkpoint is written as a two-column table (a header row, then Goal, Progress, …), which reads badly to a person: shown as headed sections instead. */
export function checkpointSections(text: string): string {
	const cells = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'))
		.map((l) => l.slice(1, l.endsWith('|') ? -1 : undefined).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')))
		.filter((c) => c.length === 2 && !/^[-:\s]+$/.test(c[0]!));
	if (cells.length < 2) return text;
	return cells.slice(1).map(([section, body]) => `#### ${section}\n\n${body}`).join('\n\n');
}

/** A person's own message is revised as plain text only: one carrying files would lose them. */
export const revisable = (r: AgentRow) => r.role === 'user' && (r.files ?? []).length === 0 && r.tag !== 'ambient';

/** Each reply whose model differs from the reply before it, and that model; a reply with no model is skipped. */
export function modelDividers(rows: readonly AgentRow[]): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	let prev: string | undefined;
	for (const r of rows) {
		const model = (r.usage as { model?: unknown } | undefined)?.model;
		if (r.role !== 'assistant' || typeof model !== 'string') continue;
		if (prev !== undefined && model !== prev) out.set(r.id, model);
		prev = model;
	}
	return out;
}
