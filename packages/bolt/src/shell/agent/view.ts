// The agent panel's pure projections of its transcript rows: the orb's mark (L-BOLT-436), the context view (L-BOLT-546)
// and the model-change dividers (L-BOLT-547). Each is a function of the rows alone, so a reload shows the same thing.
import { Array as Arr, Option, Predicate, Schema } from 'effect';
import type { AgentConversation, AgentRow } from '../../protocol/wire.ts';
import type { StudioLogLine } from '../studio/model.ts';

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
				? message.replace(/\nAnswer it with subagent message\.$/, '')
				: message
	};
}
type Args = { readonly [k: PropertyKey]: unknown };
const obj = (v: unknown): Args => (Predicate.isObject(v) && !Arr.isArray(v) ? v : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const words = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** A file's language by its extension: TypeScript, Svelte and JavaScript highlight as JavaScript. */
const languageOf = (path: string): 'javascript' | 'json' | 'plaintext' =>
	/\.(m?[jt]sx?|svelte)$/.test(path) ? 'javascript' : /\.json$/.test(path) ? 'json' : 'plaintext';
/** `model.verb` as a person says it: `invoice.update` → "Update invoice", `automation.close` → "Run close". */
export const callableWords = (callable: string) => {
	const [scope = '', act = ''] = callable.split('.');
	return scope === 'automation'
		? `Run ${act.replace(/_/g, ' ')}`
		: act === 'pipeline'
			? `Run the ${scope.replace(/_/g, ' ')} pipeline`
			: `${words(act || scope)} ${act ? scope.replace(/_/g, ' ') : ''}`.trim();
};
/** A draft path in words: `/snapshot/rule_set/EPF_MONTHLY` → `rule_set/EPF_MONTHLY`. */
const draftPath = (path: string) => path.replace(/^\/snapshot\//, '').replace(/^\//, '');
const VIEWS: { readonly [tool: string]: (a: Args) => StepView } = {
	// an inference's draft read names a path (`{ path, fields }`); the agent's record read is a layer map, keyed by its models
	read: (a) =>
		typeof a['path'] === 'string'
			? { icon: 'lucide:file-search', verb: 'Read the draft', target: draftPath(a['path']) }
			: {
					icon: 'lucide:database',
					verb: Object.values(a).some((layer) => obj(layer)['aggregate'] !== undefined)
						? 'Counted'
						: 'Read',
					target: Object.keys(a)
						.filter((key) => !key.includes('.'))
						.map((key) => key.replace(/_/g, ' '))
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
	goals: (a) => ({
		icon: 'lucide:list-checks',
		verb: 'Updated the checklist',
		target: Arr.isArray(a['items']) ? `${a['items'].length} steps` : ''
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
	workspace_lang: (a) => ({
		icon: 'lucide:braces',
		verb: 'Read workspace types',
		target: str(a['path']) || str(a['type'])
	}),
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
			(Arr.isArray(a['symbols']) ? a['symbols'].join(', ') : '')
	}),
	subagent: (a) => ({
		...(a['action'] === 'message'
			? { icon: 'lucide:send', verb: 'Sent a message to a subagent' }
			: a['action'] === 'stop'
				? { icon: 'lucide:circle-stop', verb: 'Stopped a subagent' }
				: {
						icon: 'lucide:bot',
						verb: a['action'] === 'spawn' ? 'Started a subagent' : 'Checked subagents'
					}),
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
		const changes: Args[] = Arr.isArray(a['changes']) ? a['changes'].map(obj) : [];
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
		target: Arr.isArray(a['steps']) ? `${a['steps'].length} steps` : ''
	}),
	browser_evaluate: (a) => ({
		icon: 'lucide:code',
		verb: 'Ran a script on the page',
		target: '',
		code: { text: str(a['expression']), language: 'javascript' }
	}),
	browser_screenshot: () => ({ icon: 'lucide:camera', verb: 'Took a screenshot', target: '' }),
	browser_download: (a) => ({ icon: 'lucide:download', verb: 'Downloaded', target: str(a['url']) }),
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
	const rows = Arr.isArray(r['rows']) ? r['rows'] : Arr.isArray(r['data']) ? r['data'] : null;
	return rows === null ? '' : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
}

const parsed = (text: string | undefined): unknown =>
	Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text ?? ''));
/** Why a failed step failed: its error, else its result as it came (a clipped one does not parse); '' for any other step. */
export function failureOf(tool: AgentRow['tool']): string {
	if (tool?.failed !== true) return '';
	const error = obj(parsed(tool.result))['error'];
	return typeof error === 'string' ? error : (tool.result ?? '');
}
/** What each failed step did, in words (`stepView`'s verb): the run's failure mark names them. */
export const failedVerbs = (steps: readonly AgentRow[]): string[] =>
	steps.flatMap((s) =>
		s.tool?.failed === true ? [stepView(s.tool.name, parsed(s.tool.args)).verb] : []
	);

/** What a running Studio step is doing, in the person's words: the group's line while it runs. */
const DOING: { readonly [tool: string]: string } = {
	workspace_write: 'Editing the source…',
	workspace_validate: 'Building the preview…',
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
		about['environment']?.toLowerCase() === 'live' ? 'Live' : 'Draft',
		about['message'] ?? commit?.slice(0, 7),
		about['viewport'],
		time
	]
		.filter((x) => x !== undefined && x !== '')
		.join(' · ');
}

/**
 * What the previewer may show (one at a time), oldest first: each preview a host built or captured (a `preview` or `view` role's
 * step), and each one the agent chose with `preview_show` on one of those previews' origins — the agent picks among built
 * previews, never an arbitrary page.
 */
export function previewsOf(
	rows: readonly AgentRow[]
): { url: string; key: string; about?: { readonly [k: string]: string } }[] {
	const built = new Set<string>();
	return rows.flatMap((r) => {
		const tool = r.tool,
			url = tool?.preview ?? (tool?.studio === 'view' ? tool.about?.['url'] : undefined);
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
		return tool.name === 'preview_show' && built.has(origin) ? [shown] : [];
	});
}

/** The records of a `logs` role's result (`{ records: StudioLogLine[] }`); `null` for any other step. */
const LogResult = Schema.fromJsonString(
	Schema.Struct({
		records: Schema.Array(
			Schema.Struct({
				at: Schema.String,
				level: Schema.Literals(['info', 'warn', 'error']),
				message: Schema.String
			})
		)
	})
);
export function logsOf(tool: AgentRow['tool']): readonly StudioLogLine[] | null {
	if (tool?.studio !== 'logs' || tool.failed || tool.result === undefined) return null;
	return Option.getOrNull(Schema.decodeUnknownOption(LogResult)(tool.result))?.records ?? null;
}
