// The agent panel's pure projections of its transcript rows: the orb's mark (L-BOLT-436), the context view (L-BOLT-546)
// and the model-change dividers (L-BOLT-547). Each is a function of the rows alone, so a reload shows the same thing.
import { Array as Arr, Option, Predicate, Schema } from 'effect';
import type { AgentConversation, AgentRow } from '../../protocol/wire.ts';
import type { StudioView } from '@norbital-ai/host-api';
import { humanise, handle_words } from '../i18n.ts';

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
/** A later input continues the conversation even when it came from the ordinary composer. */
export const waiting_question = (rows: readonly AgentRow[]) => rows.findLast((row) =>
	row.question !== undefined && row.answered !== true && !rows.some((later) =>
		later.seq > row.seq && later.role === 'user' && later.report === undefined && later.tag !== 'ambient' && later.state !== 'cancelled' && later.state !== 'scheduled'));
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
	if (waiting_question(o.rows) !== undefined) return 'waiting';
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
		if (r.state === 'queued' || r.state === 'scheduled' || r.state === 'pending') continue;
		if (r.id === latest?.id) continue;
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
		.flatMap((c): [string, string][] => {
			const [section, body] = c;
			return c.length === 2 && section !== undefined && body !== undefined && !/^[-:\s]+$/.test(section)
				? [[section, body]]
				: [];
		});
	if (cells.length < 2) return text;
	return cells
		.slice(1)
		.map(([section, body]) => `#### ${section}\n\n${body}`)
		.join('\n\n');
}

/** A person's posted messages can be edited, including their stored attachments. */
export const revisable = (r: AgentRow) =>
	r.role === 'user' && r.tag !== 'ambient' && r.report === undefined;

/** Each reply whose model differs from the reply before it, and that model; a reply with no model is skipped. */
export function modelDividers(rows: readonly AgentRow[]): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	let prev: string | undefined;
	for (const r of rows) {
		const model = r.usage?.model;
		if (r.role !== 'assistant' || model === undefined) continue;
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
/** A received sub-agent message, without the engine's routing prefix; unfamiliar text stays intact. */
export function reportView(row: AgentRow): (StepView & { message: string }) | null {
	if (row.report === undefined) return null;
	const text = row.text ?? '';
	const match =
		/^Sub-agent "([\s\S]*?)" \(conversation ([^)]*)\) (?:asks you|was stopped|failed|finished): ([\s\S]*)$/.exec(
			text
		);
	const parsed = match !== null && match[2] === row.report.conversation;
	const message = parsed ? (match[3] ?? '') : text;
	return {
		icon: row.report.asked === true ? 'lucide:message-circle-question' : 'lucide:inbox',
		verb: row.report.asked === true ? 'Received a question' : 'Received a message',
		target: parsed ? (match[1]?.split('\n')[0] ?? '') : '',
		message:
			parsed && row.report.asked === true
				? message.replace(/\nAnswer it with subagent_message\.$/, '')
				: message
	};
}
type Args = { readonly [k: PropertyKey]: unknown };
const obj = (v: unknown): Args => (Predicate.isObject(v) && !Arr.isArray(v) ? v : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const toolTarget = (a: Args) =>
	['query', 'url', 'name', 'id', 'text'].map((key) => str(a[key])).find((value) => value !== '') ?? '';
/** A file's language by its extension: TypeScript, Svelte and JavaScript highlight as JavaScript. */
const languageOf = (path: string): 'javascript' | 'json' | 'plaintext' =>
	/\.(m?[jt]sx?|svelte)$/.test(path) ? 'javascript' : /\.json$/.test(path) ? 'json' : 'plaintext';
/** `model.verb` as a person says it: `invoice.update` → "Update invoice", `automation.close` → "Run close". */
export const callableWords = (callable: string) => {
	const [scope = '', act = ''] = callable.split('.');
	return scope === 'automation'
		? `Run ${handle_words(act)}`
		: act === 'pipeline'
			? `Run the ${handle_words(scope)} pipeline`
			: `${humanise(act || scope)} ${act ? handle_words(scope) : ''}`.trim();
};
/** A read's keys with their options: `request`, or a transcript from before it, `reads` or its keys themselves. */
export const readsOf = (a: Args): readonly (readonly [string, unknown])[] =>
	a['request'] !== undefined
		? Object.entries(obj(a['request']))
		: Arr.isArray(a['reads'])
			? a['reads'].map((one: unknown) => [str(obj(one)['of']), one] as const)
			: Object.entries(a);
/** A draft path in words: `/snapshot/rule_set/EPF_MONTHLY` → `rule_set/EPF_MONTHLY`. */
const draftPath = (path: string) => path.replace(/^\/snapshot\//, '').replace(/^\//, '');
const VIEWS: { readonly [tool: string]: (a: Args) => StepView } = {
	// an inference's draft read names a path (`{ path, fields }`); the agent's record read is a layer map, keyed by its models
	read: (a) =>
		typeof a['path'] === 'string'
			? { icon: 'lucide:file-search', verb: 'Read the draft', target: draftPath(a['path']) }
			: {
					icon: 'lucide:database',
					verb: readsOf(a).some(([, layer]) => obj(layer)['aggregate'] !== undefined)
						? 'Counted'
						: 'Read',
					target: readsOf(a)
						.map(([key]) => key)
						.filter((key) => !key.includes('.'))
						.map((key) => key.replace(/^\$/, '').replace(/_/g, ' '))
						.join(', ')
				},
	// an inference's answer, built on its draft
	find: (a) => ({ icon: 'lucide:text-search', verb: 'Searched the draft', target: str(a['text']) }),
	edit: (a) => {
		const paths = Arr.isArray(a['ops']) ? a['ops'].map((op: unknown) => str(obj(op)['path'])) : [];
		return {
			icon: 'lucide:pencil',
			verb: 'Edited the draft',
			target: paths.length === 1 ? draftPath(paths[0] ?? '') : `${paths.length} changes`
		};
	},
	diff: (a) => ({
		icon: 'lucide:git-compare',
		verb: 'Checked the changes',
		target: draftPath(str(a['path']))
	}),
	submit: () => ({ icon: 'lucide:send', verb: 'Submitted the answer', target: '' }),
	// a write reads as what it did: "Update holiday", "Run the roster entry pipeline"
	act: (a) => ({
		icon: 'lucide:square-pen',
		verb: callableWords(str(a['callable'])),
		target: ''
	}),
	update_plan: () => ({ icon: 'lucide:notebook-pen', verb: 'Wrote the plan', target: '' }),
	compact: (a) => ({
		icon: 'lucide:shrink',
		verb: 'Compacted the context',
		target: str(a['reason'])
	}),
	skill: (a) => ({ icon: 'lucide:book-open', verb: 'Read skill', target: humanise(str(a['name'])) }),
	history: (a) => ({
		icon: 'lucide:history',
		verb: 'Searched past messages',
		target: str(a['query'])
	}),
	read_messages: () => ({ icon: 'lucide:messages-square', verb: 'Read messages', target: '' }),
	read_file: (a) => ({ icon: 'lucide:file-text', verb: 'Read file', target: str(a['text']) }),
	view_image: (a) =>
		Arr.isArray(a['crops'])
			? { icon: 'lucide:zoom-in', verb: 'Zoomed into a page', target: `${a['crops'].length} regions` }
			: { icon: 'lucide:image', verb: 'Viewed an image', target: '' },
	read_output: () => ({ icon: 'lucide:file-output', verb: 'Read the full result', target: '' }),
	geocode: (a) => ({
		icon: 'lucide:map-pin',
		verb: 'Looked up a place',
		target: str(a['query']) || str(a['address'])
	}),
	workspace_lang: (a) => ({
		icon: 'lucide:braces',
		verb: 'Read workspace types',
		target: str(a['path']) || str(a['type'])
	}),
	workspace_search: (a) => ({
		icon: 'lucide:folder-search',
		verb:
			a['pattern'] !== undefined || a['path'] === undefined ? 'Searched the source' : 'Read source',
		target:
			str(a['pattern']) ||
			str(a['path']) ||
			str(a['text']) ||
			(typeof a['rule'] === 'string' ? a['rule'] : '')
	}),
	workspace_list_dir: (a) => ({
		icon: 'lucide:folder-tree',
		verb: 'Listed the source',
		target: str(a['path'])
	}),
	workspace_read: (a) => ({
		icon: 'lucide:file-code',
		verb: 'Read source',
		target: Arr.isArray(a['paths']) ? `${a['paths'].length} files` : str(a['path'])
	}),
	subagent: (a) => ({
		icon: 'lucide:bot',
		verb: 'Started a subagent',
		target: str(a['task']).split('\n')[0] ?? ''
	}),
	subagent_read: () => ({ icon: 'lucide:bot', verb: 'Checked a subagent', target: '' }),
	subagent_message: (a) => ({
		icon: 'lucide:send',
		verb: 'Sent a message to a subagent',
		target: str(a['text']).split('\n')[0] ?? ''
	}),
	subagent_stop: () => ({ icon: 'lucide:circle-stop', verb: 'Stopped a subagent', target: '' }),
	wait: () => ({ icon: 'lucide:hourglass', verb: 'Waited for background work', target: '' }),
	document: (a) => ({
		icon: 'lucide:file-plus',
		verb: 'Made a document',
		target: str(a['name']),
		code: { text: str(a['markdown']), language: 'plaintext' }
	}),
	workspace_write: (a) => ({
		icon: 'lucide:file-pen-line',
		verb: 'Edited the source',
		target: str(a['path']),
		code: { text: str(a['content']), language: languageOf(str(a['path'])) }
	}),
	workspace_patch: (a) => ({
		icon: 'lucide:file-pen-line',
		verb: 'Edited the source',
		target: [...str(a['patch_text']).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
			.map((file) => file[1])
			.join(', ')
	}),
	workspace_edit: (a) => ({
		icon: 'lucide:file-pen-line',
		verb: 'Edited the source',
		target: str(a['path']),
		code: {
			text: `// before\n${str(a['old_string'])}\n// after\n${str(a['new_string'])}`,
			language: languageOf(str(a['path']))
		}
	}),
	workspace_move: (a) =>
		a['to'] === undefined
			? { icon: 'lucide:file-x', verb: 'Deleted source', target: str(a['path']) }
			: {
					icon: 'lucide:file-symlink',
					verb: 'Moved source',
					target: `${str(a['path'])} → ${str(a['to'])}`
				},
	workspace_commit: (a) => ({
		icon: 'lucide:git-commit-horizontal',
		verb: 'Committed',
		target: str(a['message'])
	}),
	workspace_rebase: () => ({
		icon: 'lucide:git-pull-request-arrow',
		verb: 'Rebased on live',
		target: ''
	}),
	workspace_revert: () => ({ icon: 'lucide:undo-2', verb: 'Reverted commits', target: '' }),
	workspace_install: (a) => ({
		icon: 'lucide:package-plus',
		verb: 'Installed a package',
		target: `${str(a['name'])}@${str(a['version'])}`
	}),
	workspace_preview: () => ({
		icon: 'lucide:eye',
		verb: 'Built the preview',
		target: ''
	}),
	workspace_diagnose: () => ({
		icon: 'lucide:shield-check',
		verb: 'Ran the diagnosis',
		target: ''
	}),
	// an older row keeps its words
	workspace_validate: (a) => ({
		icon: 'lucide:shield-check',
		verb: a['only'] === 'tests' ? 'Ran the tests' : 'Ran the diagnosis',
		target: ''
	}),
	workspace_test: () => ({ icon: 'lucide:flask-conical', verb: 'Started the tests', target: '' }),
	workspace_generate: () => ({
		icon: 'lucide:wand-sparkles',
		verb: 'Generated the migration',
		target: ''
	}),
	workspace_try: () => ({ icon: 'lucide:play', verb: 'Tried it on the preview', target: '' }),
	channel_check: () => ({ icon: 'lucide:radio-tower', verb: 'Checked the connection', target: '' }),
	page: (a) => ({
		icon: typeof a['path'] === 'string' ? 'lucide:arrow-up-right' : 'lucide:mouse-pointer-click',
		verb:
			typeof a['path'] === 'string'
				? 'Opened a page'
				: typeof a['highlight'] === 'string'
					? 'Pointed at'
					: 'Used your page',
		target:
			str(a['path']) ||
			str(a['click']) ||
			str(a['highlight']) ||
			str(obj(a['type'])['label']) ||
			str(a['preview'])
	}),
	describe_workspace: (a) => ({
		icon: 'lucide:map',
		verb: 'Looked up the workspace',
		target: Arr.isArray(a['names']) ? a['names'].map(str).join(', ') : ''
	}),
	workspace_review: () => ({
		icon: 'lucide:git-compare',
		verb: 'Reviewed the changes',
		target: ''
	}),
	browser: (a) => ({
		icon: 'lucide:globe',
		verb: typeof a['download'] === 'string' ? 'Downloaded' : 'Used the browser',
		target:
			str(a['url']) ||
			str(a['download']) ||
			str(obj(a['workspace'])['path']) ||
			(Arr.isArray(a['steps']) ? `${a['steps'].length} steps` : '') ||
			str(a['find']),
		...(typeof a['evaluate'] === 'string'
			? { code: { text: a['evaluate'], language: 'javascript' as const } }
			: {})
	}),
	download: (a) => ({ icon: 'lucide:download', verb: 'Downloaded', target: str(a['url']) }),
	run_js: (a) =>
		typeof a['file'] === 'string'
			? { icon: 'lucide:code', verb: 'Ran a script', target: a['file'] }
			: {
					icon: 'lucide:code',
					verb: 'Ran a script',
					target: '',
					code: { text: str(a['code']), language: 'javascript' }
				},
	web_search: (a) => ({ icon: 'lucide:search', verb: 'Searched the web', target: str(a['query']) }),
	mcp: (a) => ({
		icon: 'lucide:plug',
		verb: a['op'] === 'list' ? 'Listed external tools' : `${humanise(str(a['server']))}: ${humanise(str(a['tool']))}`,
		target: a['op'] === 'list' ? str(a['server']) : toolTarget(obj(a['input']))
	}),
	personal_skill_save: (a) => ({
		icon: 'lucide:bookmark-plus',
		verb: 'Saved a skill',
		target: humanise(str(a['name']))
	}),
	personal_skill_delete: (a) => ({
		icon: 'lucide:bookmark-minus',
		verb: 'Removed a skill',
		target: humanise(str(a['name']))
	})
};
const WHERE_OPS: { readonly [op: string]: string } = {
	eq: '=',
	ne: '≠',
	lt: '<',
	lte: '≤',
	gt: '>',
	gte: '≥',
	in: 'in',
	like: '~'
};
const operand = (v: unknown): string =>
	Arr.isArray(v)
		? v.map(operand).join(', ')
		: typeof v === 'string'
			? v
			: typeof obj(v)['var'] === 'string'
				? str(obj(v)['var'])
				: JSON.stringify(v);
/** One where's conditions in words: `status = pending`, `any of (…)`, a relation's `lines some (…)`. */
const whereChips = (where: unknown): string[] =>
	Object.entries(obj(where)).flatMap(([key, value]) => {
		if (key === 'and') return Arr.isArray(value) ? value.flatMap(whereChips) : [];
		if (key === 'or')
			return Arr.isArray(value) ? [`any of (${value.flatMap(whereChips).join(', ')})`] : [];
		if (key === 'not') return [`not (${whereChips(value).join(', ')})`];
		if (key === '$search') return [`"${operand(value)}"`];
		return Object.entries(obj(value)).map(([op, given]) =>
			op === 'is_null'
				? `${key} ${given === true ? 'is empty' : 'is set'}`
				: Object.hasOwn(WHERE_OPS, op)
					? `${key} ${WHERE_OPS[op]} ${operand(given)}`
					: `${key} ${op} (${whereChips(given).join(', ') || operand(given)})`
		);
	});
/** A read key's options as a person reads them: its filters, order, search, grouping and bounds, one chip each. */
export function readChips(layer: unknown): string[] {
	const o = obj(layer),
		aggregate = obj(o['aggregate']);
	return [
		...whereChips(o['where']),
		...(typeof o['search'] === 'string' ? [`"${o['search']}"`] : []),
		...[o['order_by']]
			.flat()
			.flatMap((by) =>
				typeof by === 'string'
					? [`↑ ${by}`]
					: Object.entries(obj(by)).map(([f, dir]) => `${dir === 'desc' ? '↓' : '↑'} ${f}`)
			),
		...(o['aggregate'] === undefined
			? []
			: [
					Object.keys(aggregate)
						.filter((k) => k !== 'by')
						.join(', ') + (aggregate['by'] === undefined ? '' : ` by ${operand(aggregate['by'])}`)
				]),
		...(Arr.isArray(o['fields']) ? [`${o['fields'].length} fields`] : []),
		...(typeof o['limit'] === 'number' ? [`limit ${o['limit']}`] : [])
	].filter((chip) => chip !== '');
}

/** A tool step's view, with its arguments decoded once. */
export function stepView(name: string, args: unknown): StepView {
	const a = obj(args);
	const known = VIEWS[name];
	if (known !== undefined) return known(a);
	return { icon: 'lucide:wrench', verb: humanise(name), target: toolTarget(a) };
}

const parsed = (text: string | undefined): unknown =>
	Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text ?? ''));
/**
 * A step's arguments for its line: the parsed JSON, else (a long call's input is stored clipped and does not parse) its
 * plain string fields recovered from the text, so `act`'s line still names its callable.
 */
export const stepArgs = (text: string | undefined): unknown =>
	parsed(text) ??
	Object.fromEntries(
		[...(text ?? '').matchAll(/"(\w+)":"((?:[^"\\]|\\.)*)"/g)].reverse().map((m) => [m[1], m[2]])
	);
/**
 * What a check that ran found: its type errors and whether its tests failed. A check's findings are its answer, never a
 * failed step; null for any other step, and for a check that could not run (no `types` or `tests` in its answer).
 */
export function checkOf(
	tool: AgentRow['tool']
): { readonly typeErrors: number; readonly testsFailed: boolean } | null {
	if (tool?.behavior.diagnostics !== true) return null;
	const answer = obj(parsed(tool.result));
	if (answer['types'] === undefined && answer['tests'] === undefined) return null;
	const total = obj(answer['types'])['total'];
	return {
		typeErrors: typeof total === 'number' ? total : 0,
		testsFailed: obj(answer['tests'])['state'] === 'failed'
	};
}
/** Why a failed step failed: its error, else its result as it came (a clipped one does not parse); '' for any other step. */
export function failureOf(tool: AgentRow['tool']): string {
	if (tool?.failed !== true || checkOf(tool) !== null) return '';
	const error = obj(parsed(tool.result))['error'];
	return typeof error === 'string' ? error : (tool.result ?? '');
}
/** What each failed step did, in words (`stepView`'s verb): the run's failure mark names them. */
export const failedVerbs = (steps: readonly AgentRow[]): string[] =>
	steps.flatMap((s) =>
		s.tool?.failed === true && checkOf(s.tool) === null
			? [stepView(s.tool.name, stepArgs(s.tool.args)).verb]
			: []
	);

/** What a running Studio step is doing, in the person's words: the group's line while it runs. */
const DOING: { readonly [tool: string]: string } = {
	workspace_write: 'Editing the source…',
	workspace_edit: 'Editing the source…',
	workspace_patch: 'Editing the source…',
	workspace_move: 'Editing the source…',
	workspace_commit: 'Committing…',
	workspace_merge_message: 'Setting the merge message…',
	workspace_rebase: 'Rebasing on live…',
	workspace_revert: 'Reverting commits…',
	workspace_preview: 'Building the preview…',
	workspace_diagnose: 'Running the diagnosis…',
	workspace_test: 'Starting the tests…',
	workspace_generate: 'Generating the migration…',
	workspace_try: 'Trying it on the preview…',
	workspace_review: 'Reviewing the changes…'
};
export const doingOf = (steps: readonly AgentRow[]): string =>
	DOING[steps.findLast((s) => s.tool?.running === true)?.tool?.name ?? ''] ?? 'Working…';

/** What a Studio result shows in one line, in a person's words: "Draft · Rename title · 390×844 · 23:05" (never an id). */
export function captionOf(
	about: { readonly [k: string]: string } | undefined,
	zone?: string
): string {
	if (about === undefined) return '';
	const commit = about['commit'],
		at = about['capturedAt'];
	const time =
		at === undefined || Number.isNaN(Date.parse(at))
			? undefined
			: new Date(at).toLocaleTimeString(undefined, {
					hour: '2-digit',
					minute: '2-digit',
					hourCycle: 'h23',
					...(zone === undefined ? {} : { timeZone: zone })
				});
	return [
		about['environment']?.toLowerCase() === 'live' ? 'Live' : 'Preview',
		about['message'] ?? commit?.slice(0, 7),
		about['viewport'],
		time
	]
		.filter((x) => x !== undefined && x !== '')
		.join(' · ');
}

/**
 * What the previewer may show (one at a time), oldest first: each preview a host built or captured (a `preview` or `view` role's
 * step), and each one the agent chose with `page { preview }` on one of those previews' origins — the agent picks among
 * built previews, never an arbitrary page.
 */
export function previewsOf(
	rows: readonly AgentRow[]
): { url: string; key: string; about?: { readonly [k: string]: string } }[] {
	const built = new Set<string>();
	return rows.flatMap((r) => {
		const tool = r.tool,
			url =
				tool?.preview ??
				(tool?.studio === 'view' && tool.about?.['commit'] !== undefined
					? tool.about['url']
					: undefined);
		if (tool === undefined || tool.failed || url === undefined || !URL.canParse(url)) return [];
		// the bundle: its release when the step names one, else the step itself (a rebuild at the same address)
		const origin = new URL(url).origin,
			shown = {
				url,
				key: tool.about?.['release'] ?? r.id,
				...(tool.about === undefined ? {} : { about: tool.about })
			};
		if (tool.studio === 'preview' || tool.studio === 'view') {
			built.add(origin);
			return [shown];
		}
		return tool.name === 'page' && built.has(origin) ? [shown] : [];
	});
}

/** A merged change no longer has a preview environment; show the published workspace instead. */
export function currentPreview(
	preview: ReturnType<typeof previewsOf>[number],
	studio: Pick<StudioView, 'change_sets' | 'environments' | 'releases'>
): ReturnType<typeof previewsOf>[number] {
	const commit = preview.about?.['commit'];
	const change = studio.change_sets?.find(
		(one) => commit !== undefined && (one.head === commit || one.preview?.commit === commit)
	);
	if (change?.state !== 'merged') return preview;
	const live = studio.environments?.find((one) => one.name === 'live');
	if (live?.url == null || live.release === '') return preview;
	const release = studio.releases.find((one) => one.current);
	return {
		url: live.url,
		key: live.release,
		about: {
			environment: 'live',
			...(release === undefined ? {} : { commit: release.commit, message: release.message })
		}
	};
}
