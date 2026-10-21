// The agent panel's pure projections of its transcript rows: the orb's mark (L-BOLT-436), the context view (L-BOLT-546)
// and the model-change dividers (L-BOLT-547). Each is a function of the rows alone, so a reload shows the same thing.
import { Predicate } from 'effect';
import type { AgentConversation, AgentRow } from '../../protocol/wire.ts';

/** One mark per state: waiting on a person is not failing, and a finished or stopped turn is not idle. */
export type Orb = 'ready' | 'working' | 'waiting' | 'failed' | 'done' | 'stopped';
/** Every mark's name (a `t()` key) and icon; `working` is the accretion disc. */
export const ORB: { readonly [o in Orb]: { label: string; icon: string } } = {
	ready: { label: 'Ready', icon: 'lucide:circle-dashed' },
	working: { label: 'Working…', icon: 'lucide:loader' },
	waiting: { label: 'Waiting for you', icon: 'lucide:hand' },
	failed: { label: 'Failed', icon: 'lucide:circle-alert' },
	done: { label: 'Done', icon: 'lucide:circle-check' },
	stopped: { label: 'Stopped', icon: 'lucide:circle-stop' }
};
/**
 * The conversation's mark. A caller's own knowledge wins: `failed` (a send it saw fail) over everything, `pending` (a
 * turn it just dispatched, before any status arrived) over the rows.
 */
export function orbState(o: {
	status: 'idle' | 'running' | 'stopped';
	rows: readonly AgentRow[];
	pending?: boolean;
	failed?: boolean;
}): Orb {
	if (o.failed === true) return 'failed';
	if (o.pending === true || o.status === 'running' || o.rows.some((r) => r.state === 'approved'))
		return 'working';
	if (o.status === 'stopped') return 'stopped';
	if (o.rows.some((r) => r.state === 'confirm')) return 'waiting';
	const last = o.rows.findLast((r) => r.role === 'assistant');
	return last?.tag === 'failed' ? 'failed' : last?.tag === 'reply' ? 'done' : 'ready';
}

/**
 * What the model no longer reads: rows summarized into the latest checkpoint (not the ones it kept, and never input
 * still waiting or delivered after it), and the discussion before an executed plan. A draft plan moves nothing, so a
 * planning revision stays in full view until its plan runs. `origin` is the latest checkpoint's own provenance.
 */
export function contextView(
	rows: readonly AgentRow[],
	plan: AgentConversation['plan'] | undefined
): { outside: ReadonlySet<string>; origin: 'manual' | 'requested' | 'automatic' | null } {
	const latest = rows.findLast((r) => r.compact !== undefined);
	const planAt =
		plan !== null && plan !== undefined && plan.status !== 'draft' ? plan.checkpoint : undefined;
	const outside = new Set<string>();
	for (const r of rows) {
		if (r.state === 'queued' || r.state === 'pending' || r.id === latest?.id) continue;
		const summarized =
			latest?.compact !== undefined &&
			r.seq <= latest.compact.cutoff &&
			!latest.compact.keep.includes(r.id);
		if (summarized || (planAt !== undefined && r.seq <= planAt)) outside.add(r.id);
	}
	return { outside, origin: latest?.compact?.origin ?? null };
}

/** A checkpoint is written as a two-column table (a header row, then Goal, Progress, …), which reads badly to a person: shown as headed sections instead. */
export function checkpointSections(text: string): string {
	const cells = text
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith('|'))
		.map((l) =>
			l
				.slice(1, l.endsWith('|') ? -1 : undefined)
				.split(/(?<!\\)\|/)
				.map((c) => c.trim().replace(/\\\|/g, '|'))
		)
		.filter((c) => c.length === 2 && !/^[-:\s]+$/.test(c[0]!));
	if (cells.length < 2) return text;
	return cells
		.slice(1)
		.map(([section, body]) => `#### ${section}\n\n${body}`)
		.join('\n\n');
}

/** A person's own message is revised as plain text only: one carrying files would lose them. */
export const revisable = (r: AgentRow) =>
	r.role === 'user' && (r.files ?? []).length === 0 && r.tag !== 'ambient';

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

/**
 * A sub-agent's state for its chip and panel. Its conversation's status decides stopped (a stop between steps leaves no
 * row that says so); otherwise a reply or call still being written, or no settled reply yet, is working.
 */
export function childStatus(
	rows: readonly AgentRow[],
	status: 'idle' | 'running' | 'stopped' | undefined
): 'running' | 'stopped' | 'failed' | 'asking' | 'done' {
	if (status === 'stopped') return 'stopped';
	const last = rows.findLast((r) => r.role === 'assistant');
	if (
		rows.some((r) => r.state === 'streaming' || r.state === 'running') ||
		last === undefined ||
		(last.tag !== 'reply' && last.tag !== 'failed' && last.tag !== 'cut')
	)
		return 'running';
	if (last.tag === 'cut') return 'stopped';
	if (last.tag === 'failed') return 'failed';
	const thread = rows
		.slice(rows.findIndex((r) => r.role === 'user') + 1)
		.filter(
			(r) =>
				!!r.text &&
				(r.role === 'user' || (r.role === 'assistant' && (r.tag === 'reply' || r.tag === 'failed')))
		);
	return thread.at(-1)?.asked === true ? 'asking' : 'done';
}

/** The detached work a conversation started, in the order it started: each sub-agent and each automation run, once. */
export function background(
	rows: readonly AgentRow[]
): readonly { kind: 'agent' | 'run'; id: string }[] {
	const out = new Map<string, { kind: 'agent' | 'run'; id: string }>();
	for (const r of rows) {
		if (r.tool?.child !== undefined && !out.has(r.tool.child))
			out.set(r.tool.child, { kind: 'agent', id: r.tool.child });
		for (const id of r.tool?.runs ?? []) if (!out.has(id)) out.set(id, { kind: 'run', id });
	}
	return [...out.values()];
}

/** An automation run's state in the session rail: queued counts as running, a skipped run as done. */
export const runState = (status: string): 'running' | 'done' | 'failed' | 'stopped' =>
	status === 'queued' || status === 'running'
		? 'running'
		: status === 'failed'
			? 'failed'
			: status === 'stopped'
				? 'stopped'
				: 'done';

/** How a tool step reads at a glance: its icon, what it did in words, on what, and any code it carried (highlighted). */
export type StepView = {
	icon: string;
	verb: string;
	target: string;
	code?: { text: string; language: 'javascript' | 'json' | 'plaintext' };
};
type Args = { readonly [k: PropertyKey]: unknown };
const obj = (v: unknown): Args => (Predicate.isObject(v) && !Array.isArray(v) ? v : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const words = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** A file's language by its extension: TypeScript, Svelte and JavaScript highlight as JavaScript. */
const languageOf = (path: string): 'javascript' | 'json' | 'plaintext' =>
	/\.(m?[jt]sx?|svelte)$/.test(path) ? 'javascript' : /\.json$/.test(path) ? 'json' : 'plaintext';
/** `collection.verb` as a person says it: `invoice.update` → "Update invoice", `automation.close` → "Run close". */
export const callableWords = (callable: string) => {
	const [scope = '', act = ''] = callable.split('.');
	return scope === 'automation'
		? `Run ${act.replace(/_/g, ' ')}`
		: act === 'pipeline'
			? `Run the ${scope.replace(/_/g, ' ')} pipeline`
			: `${words(act || scope)} ${act ? scope.replace(/_/g, ' ') : ''}`.trim();
};
const VIEWS: { readonly [tool: string]: (a: Args) => StepView } = {
	read: (a) => ({
		icon: 'lucide:database',
		verb: a['aggregate'] === undefined ? 'Read' : 'Counted',
		target: Array.isArray(a['reads'])
			? a['reads'].map((r: unknown) => str(obj(r)['collection']).replace(/_/g, ' ')).join(', ')
			: str(a['collection']).replace(/_/g, ' ') || str(a['query'])
	}),
	// a write reads as what it did: "Update holiday", "Run the roster entry pipeline"
	act: (a) => ({
		icon: 'lucide:square-pen',
		verb: Array.isArray(a['actions'])
			? a['actions'].map((x: unknown) => callableWords(str(obj(x)['callable']))).join(', ')
			: callableWords(str(a['callable'])),
		target: ''
	}),
	update_plan: () => ({ icon: 'lucide:notebook-pen', verb: 'Wrote the plan', target: '' }),
	goals: (a) => ({
		icon: 'lucide:list-checks',
		verb: 'Updated the checklist',
		target: Array.isArray(a['items']) ? `${a['items'].length} steps` : ''
	}),
	compact: (a) => ({
		icon: 'lucide:shrink',
		verb: 'Compacted the context',
		target: str(a['reason'])
	}),
	skill: (a) => ({ icon: 'lucide:book-open', verb: 'Read skill', target: words(str(a['name'])) }),
	history: (a) => ({
		icon: 'lucide:history',
		verb: 'Searched past messages',
		target: str(a['query'])
	}),
	read_output: () => ({ icon: 'lucide:file-output', verb: 'Read the full result', target: '' }),
	read_messages: () => ({ icon: 'lucide:messages-square', verb: 'Read messages', target: '' }),
	read_attachment: (a) => ({
		icon: 'lucide:paperclip',
		verb: 'Read attachment',
		target: str(a['name']) || str(a['file'])
	}),
	read_file: (a) => ({
		icon: 'lucide:file-text',
		verb: 'Read file',
		target: str(a['name']) || str(a['id'])
	}),
	geocode: (a) => ({
		icon: 'lucide:map-pin',
		verb: 'Looked up a place',
		target: str(a['query']) || str(a['address'])
	}),
	workspace_type: () => ({ icon: 'lucide:braces', verb: 'Read workspace types', target: '' }),
	workspace_search: (a) => ({
		icon: 'lucide:folder-search',
		verb: a['path'] === undefined ? 'Searched the source' : 'Read source',
		target: str(a['path']) || str(a['text']) || (typeof a['rule'] === 'string' ? a['rule'] : '')
	}),
	docs: (a) => ({
		icon: 'lucide:library',
		verb: 'Read the docs',
		target:
			str(a['query']) ||
			str(a['namespace']) ||
			(Array.isArray(a['symbols']) ? a['symbols'].join(', ') : '')
	}),
	subagent: (a) => ({
		icon: 'lucide:bot',
		verb:
			a['action'] === 'spawn'
				? 'Started a helper'
				: a['action'] === 'message'
					? 'Messaged a helper'
					: a['action'] === 'stop'
						? 'Stopped a helper'
						: 'Checked a helper',
		target: (str(a['task']) || str(a['text'])).split('\n')[0] ?? ''
	}),
	wait: () => ({ icon: 'lucide:hourglass', verb: 'Waited for background work', target: '' }),
	ask_parent: (a) => ({
		icon: 'lucide:message-circle-question',
		verb: 'Asked the main agent',
		target: str(a['question']).split('\n')[0] ?? ''
	}),
	document: (a) => ({
		icon: 'lucide:file-plus',
		verb: 'Made a document',
		target: str(a['name']),
		code: { text: str(a['markdown']), language: 'plaintext' }
	}),
	workspace_write: (a) => {
		const changes: Args[] = Array.isArray(a['changes']) ? a['changes'].map(obj) : [];
		const first = changes[0] ?? {};
		// a whole file is its text; a find/replace edit shows what it replaced and with what
		const text = changes
			.map((c) =>
				typeof c['text'] === 'string'
					? c['text']
					: typeof c['replace'] === 'string'
						? `// before\n${str(c['find'])}\n// after\n${c['replace']}`
						: ''
			)
			.filter((t) => t !== '')
			.join('\n\n');
		return {
			icon: 'lucide:file-pen-line',
			verb: 'Edited the source',
			target: changes.map((c) => str(c['path'])).join(', '),
			...(text === '' ? {} : { code: { text, language: languageOf(str(first['path'])) } })
		};
	},
	workspace_validate: () => ({
		icon: 'lucide:shield-check',
		verb: 'Checked the source',
		target: ''
	}),
	workspace_review: () => ({
		icon: 'lucide:git-compare',
		verb: 'Reviewed the changes',
		target: ''
	}),
	browser_navigate: (a) => ({
		icon: 'lucide:globe',
		verb: 'Opened a page',
		target: str(a['url']) || str(a['go'])
	}),
	browser_snapshot: (a) => ({
		icon: 'lucide:scan-text',
		verb: 'Read the page',
		target: str(a['find'])
	}),
	browser_act: (a) => ({
		icon: 'lucide:mouse-pointer-click',
		verb: 'Used the page',
		target: Array.isArray(a['steps']) ? `${a['steps'].length} steps` : ''
	}),
	browser_evaluate: (a) => ({
		icon: 'lucide:code',
		verb: 'Ran a script on the page',
		target: '',
		code: { text: str(a['expression']), language: 'javascript' }
	}),
	browser_screenshot: () => ({ icon: 'lucide:camera', verb: 'Took a screenshot', target: '' }),
	web_search: (a) => ({ icon: 'lucide:search', verb: 'Searched the web', target: str(a['query']) }),
	sandbox_run: (a) => {
		const line = [
			str(a['command']),
			...(Array.isArray(a['args']) ? a['args'].map(String) : [])
		].join(' ');
		const script = Array.isArray(a['args'])
			? a['args'].map(String).find((x) => x.includes('\n'))
			: undefined;
		return {
			icon: 'lucide:terminal',
			verb: 'Ran a command',
			target: line.split('\n')[0] ?? '',
			code: {
				text: script ?? line,
				language: /^(node|deno|bun)$/.test(str(a['command'])) ? 'javascript' : 'plaintext'
			}
		};
	},
	personal_skill_save: (a) => ({
		icon: 'lucide:bookmark-plus',
		verb: 'Saved a skill',
		target: words(str(a['name']))
	}),
	personal_skill_delete: (a) => ({
		icon: 'lucide:bookmark-minus',
		verb: 'Removed a skill',
		target: words(str(a['name']))
	})
};
/** A tool step's view (its arguments decoded once); an MCP tool names its server, anything else its own name. */
export function stepView(name: string, args: unknown): StepView {
	const a = obj(args);
	const known = VIEWS[name];
	if (known !== undefined) return known(a);
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	const target =
		['query', 'url', 'name', 'id', 'text'].map((k) => str(a[k])).find((v) => v !== '') ?? '';
	return mcp === null
		? { icon: 'lucide:wrench', verb: words(name), target }
		: { icon: 'lucide:plug', verb: `${words(mcp[1]!)}: ${words(mcp[2]!)}`, target };
}

/** A result in one line: its error, a row count, or nothing (the Output tab has the rest). */
export function resultLine(result: unknown): string {
	const r = obj(result);
	if (typeof r['error'] === 'string') return r['error'];
	const rows = Array.isArray(r['rows']) ? r['rows'] : Array.isArray(r['data']) ? r['data'] : null;
	return rows === null ? '' : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
}
