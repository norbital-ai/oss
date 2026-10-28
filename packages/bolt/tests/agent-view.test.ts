// The agent panel's projections (L-BOLT-436, L-BOLT-546, L-BOLT-547): pure functions of the transcript rows.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { rowsOf, transcriptRow } from '../src/engine/agent/schema.ts';
import type { Json } from '../src/decl/values.ts';
import type { AgentRow } from '../src/protocol/wire.ts';
import {
	background,
	checkpointSections,
	childStatus,
	contextView,
	doingOf,
	failedVerbs,
	failureOf,
	modelDividers,
	ORB,
	orbState,
	captionOf,
	logsOf,
	previewsOf,
	reportView,
	resultLine,
	revisable,
	runState,
	stepView,
	type Orb
} from '../src/shell/agent/view.ts';

const row = (seq: number, o: Partial<AgentRow> = {}): AgentRow => ({
	id: `m${seq}`,
	seq,
	role: 'user',
	text: `t${seq}`,
	state: 'consumed',
	tag: null,
	...o
});
const reply = (seq: number, model?: string, tag = 'reply'): AgentRow =>
	row(seq, {
		role: 'assistant',
		tag,
		...(model === undefined ? {} : { usage: { input: 1, output: 1, calls: 1, model } })
	});

describe('the orb (L-BOLT-436)', () => {
	it('gives every state its own named mark: waiting on a person is not failing, finished and stopped are not idle', () => {
		const cases: [Orb, Parameters<typeof orbState>[0]][] = [
			['ready', { status: 'idle', rows: [] }],
			['working', { status: 'running', rows: [] }],
			[
				'waiting',
				{ status: 'idle', rows: [row(1, { role: 'tool', state: 'confirm', tag: 'confirm' })] }
			],
			['failed', { status: 'idle', rows: [reply(1, undefined, 'failed')] }],
			['done', { status: 'idle', rows: [reply(1)] }],
			['stopped', { status: 'stopped', rows: [reply(1)] }]
		];
		for (const [mark, input] of cases) expect(orbState(input)).toBe(mark);
		expect(new Set(Object.values(ORB).map((o) => o.label)).size).toBe(Object.keys(ORB).length);
	});
	it('lets the caller override: a turn it just dispatched works, a send it saw fail outranks the status', () => {
		expect(orbState({ status: 'idle', rows: [reply(1)], pending: true })).toBe('working');
		expect(orbState({ status: 'running', rows: [], failed: true })).toBe('failed');
	});
});

describe('the context view (L-BOLT-546)', () => {
	it('puts summarized rows outside, but not the rows the checkpoint kept, input still waiting or anything after it', () => {
		const rows = [
			row(1),
			reply(2),
			row(3, { state: 'queued' }),
			row(4),
			row(5, {
				role: 'system',
				tag: 'compact',
				compact: { cutoff: 4, keep: ['m4'], origin: 'requested' }
			}),
			row(6)
		];
		const view = contextView(rows, null);
		expect([...view.outside]).toEqual(['m1', 'm2']);
		expect(view.origin).toBe('requested');
	});
	it('a draft plan moves nothing; an executed one puts the discussion before it outside', () => {
		const rows = [row(1), reply(2), row(3), reply(4)];
		expect(
			contextView(rows, { revision: 1, body: 'p', status: 'draft', checkpoint: 0 }).outside.size
		).toBe(0);
		expect([
			...contextView(rows, { revision: 2, body: 'p', status: 'active', checkpoint: 2 }).outside
		]).toEqual(['m1', 'm2']);
	});
	it('shows a checkpoint table as headed sections, and other text as it came', () => {
		expect(
			checkpointSections(
				"| Row | Summary |\n|---|---|\n| Goal | Pay run |\n| What's left | Approve |"
			)
		).toBe("#### Goal\n\nPay run\n\n#### What's left\n\nApprove");
		expect(checkpointSections('plain text')).toBe('plain text');
	});
	it('revises only a plain-text message of the person', () => {
		expect(revisable(row(1))).toBe(true);
		expect(revisable(row(1, { files: [{ name: 'a.pdf', mime: 'application/pdf' }] }))).toBe(false);
		expect(revisable(reply(1))).toBe(false);
	});
});

describe('the model-change divider (L-BOLT-547)', () => {
	it('marks every change, a switch back too, and nothing between replies of one model; a reply with no model is skipped', () => {
		const rows = [
			row(1),
			reply(2, 'fast'),
			row(3),
			reply(4, 'strong'),
			reply(5),
			reply(6, 'strong'),
			reply(7, 'fast')
		];
		expect([...modelDividers(rows)]).toEqual([
			['m4', 'strong'],
			['m7', 'fast']
		]);
		expect([...modelDividers(rows)]).toEqual([...modelDividers(rows.map((r) => ({ ...r })))]);
	});
});

describe('tool steps', () => {
	it('gives each tool its own icon and words, code its language, and an unknown or MCP tool a fallback', () => {
		// a read names its roots: the layer map's keys without a dot
		expect(stepView('read', { leave_entry: {}, 'leave_entry.employee': {} })).toEqual({
			icon: 'lucide:database',
			verb: 'Read',
			target: 'leave entry'
		});
		expect(stepView('act', { callable: 'invoice.update' }).verb).toBe('Update invoice');
		expect(stepView('act', { callable: 'automation.close_month' }).verb).toBe('Run close month');
		expect(stepView('act', { callable: 'roster_entry.pipeline' }).verb).toBe(
			'Run the roster entry pipeline'
		);
		expect(stepView('document', { name: 'Q3.pptx', markdown: '## One' })).toMatchObject({
			icon: 'lucide:file-plus',
			target: 'Q3.pptx',
			code: { text: '## One' }
		});
		expect(
			stepView('workspace_write', { changes: [{ path: 'a.ts', find: 'old', replace: 'new' }] }).code
		).toEqual({ text: '// before\nold\n// after\nnew', language: 'javascript' });
		expect(
			stepView('workspace_write', {
				changes: [{ path: 'src/app/+page.svelte', text: '<h1>Hi</h1>' }]
			})
		).toMatchObject({
			icon: 'lucide:file-pen-line',
			target: 'src/app/+page.svelte',
			code: { text: '<h1>Hi</h1>', language: 'javascript' }
		});
		expect(stepView('browser_evaluate', { expression: 'a\nb' }).code).toEqual({
			text: 'a\nb',
			language: 'javascript'
		});
		expect(stepView('mcp__hq__find_ticket', { query: 'late' })).toEqual({
			icon: 'lucide:plug',
			verb: 'Hq: Find ticket',
			target: 'late'
		});
		expect(stepView('mystery', null)).toEqual({
			icon: 'lucide:wrench',
			verb: 'Mystery',
			target: ''
		});
		const tools = [
			'read',
			'act',
			'goals',
			'subagent',
			'wait',
			'document',
			'workspace_write',
			'browser_navigate',
			'browser_evaluate'
		];
		expect(new Set(tools.map((n) => stepView(n, {}).icon)).size).toBe(tools.length);
	});
	it('names each subagent action and previews only the task or message, never its conversation id', () => {
		const conversation = '620df511-790d-4570-9d1e-1fddf492ba86';
		expect(
			stepView('subagent', { action: 'spawn', task: 'Review invoices\nCheck totals' })
		).toEqual({
			icon: 'lucide:bot',
			verb: 'Started a subagent',
			target: 'Review invoices'
		});
		expect(
			stepView('subagent', {
				action: 'message',
				conversation,
				text: 'Use the new rates\nFor October'
			})
		).toEqual({
			icon: 'lucide:send',
			verb: 'Sent a message to a subagent',
			target: 'Use the new rates'
		});
		expect(stepView('subagent', { action: 'stop', conversation })).toEqual({
			icon: 'lucide:circle-stop',
			verb: 'Stopped a subagent',
			target: ''
		});
		for (const action of ['list', 'read', 'query'])
			expect(stepView('subagent', { action, conversation })).toEqual({
				icon: 'lucide:bot',
				verb: 'Checked subagents',
				target: ''
			});
	});
	it('reads a result in one line: its error or its row count', () => {
		expect(resultLine({ error: 'No such field' })).toBe('No such field');
		expect(resultLine({ rows: [1, 2] })).toBe('2 rows');
		expect(resultLine('plain')).toBe('');
	});
});

describe('subagent messages', () => {
	const conversation = '620df511-790d-4570-9d1e-1fddf492ba86';
	it('requires report metadata even when the text resembles a report', () => {
		expect(
			reportView(
				row(1, {
					text: `Sub-agent "Review invoices" (conversation ${conversation}) finished: Done`
				})
			)
		).toBeNull();
	});
	it('reads the task title and keeps the entire message, including quotes and newlines', () => {
		const task = 'Review "invoices"\nCheck totals';
		const message = 'Checked "October" invoices.\nTotals match.\n\nReady for review.';
		for (const state of ['finished', 'failed', 'was stopped'])
			expect(
				reportView(
					row(1, {
						report: { conversation },
						text: `Sub-agent "${task}" (conversation ${conversation}) ${state}: ${message}`
					})
				)
			).toEqual({
				icon: 'lucide:inbox',
				verb: 'Received a message',
				target: 'Review "invoices"',
				message
			});
	});
	it('identifies a question from its metadata and removes only the engine instruction', () => {
		const message = 'Which month should I use?\nThe draft has September and October.';
		expect(
			reportView(
				row(1, {
					report: { conversation, asked: true },
					text: `Sub-agent "Review invoices" (conversation ${conversation}) asks you: ${message}\nAnswer it with subagent message.`
				})
			)
		).toEqual({
			icon: 'lucide:message-circle-question',
			verb: 'Received a question',
			target: 'Review invoices',
			message
		});
	});
	it('preserves unexpected text or a mismatched conversation without inventing a task title', () => {
		for (const text of [
			'A report in another format.\nKeep every line.',
			'Sub-agent "Review invoices" (conversation another-conversation) finished: Done',
			null
		])
			expect(reportView(row(1, { report: { conversation }, text }))).toEqual({
				icon: 'lucide:inbox',
				verb: 'Received a message',
				target: '',
				message: text ?? ''
			});
	});
});

describe('a sub-agent chip', () => {
	it('reads stopped from its conversation even when the stop left a settled, untagged step or no step at all', () => {
		const step = row(2, { role: 'assistant', tag: null, state: null, text: '' });
		expect(childStatus([row(1)], 'stopped')).toBe('stopped');
		expect(childStatus([row(1), step], 'stopped')).toBe('stopped');
		// the same rows while it works are working, not stopped
		expect(childStatus([row(1), step], 'running')).toBe('running');
		expect(childStatus([row(1), reply(2)], 'idle')).toBe('done');
		expect(
			childStatus([row(1), row(2, { role: 'assistant', tag: 'reply', asked: true })], 'idle')
		).toBe('asking');
		expect(childStatus([row(1), reply(2, undefined, 'failed')], 'idle')).toBe('failed');
	});
});

describe('background work in the session rail', () => {
	it('lists each sub-agent and automation run once, in the order they started', () => {
		const tool = (seq: number, t: Partial<NonNullable<AgentRow['tool']>>) =>
			row(seq, { role: 'tool', tool: { name: 'act', failed: false, ...t } });
		expect(
			background([
				row(1),
				tool(2, { name: 'subagent', child: 'c1' }),
				tool(3, { runs: ['r1', 'r2'] }),
				tool(4, { runs: ['r2'] }),
				tool(5, { name: 'subagent', child: 'c1' })
			])
		).toEqual([
			{ kind: 'agent', id: 'c1' },
			{ kind: 'run', id: 'r1' },
			{ kind: 'run', id: 'r2' }
		]);
	});
	it('reads a queued run as running and a skipped one as done', () => {
		expect(
			['queued', 'running', 'succeeded', 'skipped', 'failed', 'stopped'].map(runState)
		).toEqual(['running', 'running', 'done', 'done', 'failed', 'stopped']);
	});
});

describe('Studio outcomes outside the folded steps', () => {
	// a host's Studio tools by the roles they declare
	const ROLE = {
		workspace_validate: 'preview',
		workspace_view: 'view',
		workspace_logs: 'logs',
		workspace_publish: 'publish',
		workspace_rollback: 'rollback'
	} as const;
	const tool = (name: string, result?: string, o: Partial<NonNullable<AgentRow['tool']>> = {}) => ({
		name,
		failed: false,
		...Object.fromEntries(
			Object.entries(ROLE)
				.filter(([n]) => n === name)
				.map(([, studio]) => ['studio', studio])
		),
		...(result === undefined ? {} : { result }),
		...o
	});
	it('names the running Studio step, else the generic line', () => {
		const step = (seq: number, name: string, running?: true) =>
			row(seq, { role: 'tool', tool: tool(name, undefined, running ? { running } : {}) });
		expect(doingOf([step(1, 'workspace_write'), step(2, 'workspace_validate', true)])).toBe(
			'Building the preview…'
		);
		expect(doingOf([step(1, 'read', true)])).toBe('Working…');
	});
	it('a failed step says why, and the run names what failed', () => {
		const failed = (name: string, args: string, result: string) =>
			row(1, { role: 'tool', tool: { ...tool(name, result), failed: true, args } });
		expect(failureOf(tool('read', '{"error":"No month field"}', { failed: true }))).toBe(
			'No month field'
		);
		// a clipped result does not parse: shown as it came
		expect(failureOf(tool('read', '{"error":"No mon', { failed: true }))).toBe('{"error":"No mon');
		expect(failureOf(tool('read', '{"error":"x"}'))).toBe('');
		expect(
			failedVerbs([
				row(1, { role: 'tool', tool: tool('read', '{}') }),
				failed('browser_download', '{"url":"https://a.test/x"}', '{"error":"404"}')
			])
		).toEqual(['Downloaded']);
	});
	it('the previewer shows built previews and the ones the agent chose among them, never another page', () => {
		const step = (seq: number, name: string, o: Partial<NonNullable<AgentRow['tool']>>) =>
			row(seq, { role: 'tool', tool: tool(name, '{}', o) });
		const about = { environment: 'Preview', commit: 'abc1234def', message: 'Rename title' };
		expect(
			previewsOf([
				step(1, 'preview_show', { preview: 'https://a.test/early' }),
				step(2, 'workspace_validate', { preview: 'https://a.test/', about }),
				step(3, 'workspace_validate', { preview: 'https://b.test/', failed: true }),
				step(4, 'preview_show', { preview: 'https://evil.test/' }),
				step(5, 'preview_show', { preview: 'https://a.test/page' }),
				step(6, 'workspace_view', { about: { ...about, url: 'https://c.test/' } })
			]).map((p) => p.url)
		).toEqual(['https://a.test/', 'https://a.test/page', 'https://c.test/']);
		// a bundle is its release when the step names one, else the step: the same bundle never reloads the frame
		expect(
			previewsOf([
				step(1, 'workspace_validate', { preview: 'https://a.test/', about: { release: 'r1' } }),
				step(2, 'workspace_validate', { preview: 'https://a.test/' })
			]).map((p) => p.key)
		).toEqual(['r1', expect.any(String)]);
		expect(
			captionOf(
				{
					...about,
					branch: 'draft u/dion',
					viewport: '390×844',
					capturedAt: '2026-10-21T15:05:00Z'
				},
				'Asia/Singapore'
			)
		).toBe('Draft · Rename title · 390×844 · 23:05');
	});
	it('lists a runtime log result by level, and nothing for any other tool', () => {
		const result = JSON.stringify({
			records: [
				{ at: '2026-10-21T15:05:01Z', level: 'error', message: 'boom' },
				{ at: '2026-10-21T15:05:02Z', level: 'info', message: 'ok' }
			]
		});
		expect(logsOf(tool('workspace_logs', result))).toEqual([
			{ at: '2026-10-21T15:05:01Z', level: 'error', message: 'boom' },
			{ at: '2026-10-21T15:05:02Z', level: 'info', message: 'ok' }
		]);
		expect(logsOf(tool('read', result))).toBeNull();
	});
	it.effect('a step whose answer is a held request names it in full, for the card to decide', () =>
		Effect.gen(function* () {
			const message = (seq: number, result: Json) => ({
				r: {
					id: `m${seq}`,
					conversation: 'c',
					seq,
					role: 'tool',
					content: { id: `k${seq}`, name: 'workspace_merge', studio: 'merge', result },
					text: null,
					state: null,
					mode: null,
					as: null,
					author: null,
					meta: null,
					supersedes: null,
					turn: 't'
				}
			});
			const [held, refused] = yield* rowsOf([
				message(1, { approval: { id: 'r1', op: { op: 'publish' }, note: 'x'.repeat(700) } }),
				message(2, { error: 'Your draft is at c2, not c1; nothing was published.' })
			]);
			expect(held && transcriptRow(held, true, false)?.tool).toMatchObject({
				studio: 'merge',
				approval: 'r1'
			});
			expect(refused && transcriptRow(refused, true, false)?.tool?.approval).toBeUndefined();
			expect(refused && transcriptRow(refused, true, false)?.tool?.failed).toBe(true);
			// a run read in detail carries the run's own `error: null`: the step did not fail
			const [run] = yield* rowsOf([message(3, { id: 'r1', status: 'succeeded', error: null })]);
			expect(run && transcriptRow(run, true, false)?.tool?.failed).toBe(false);
		})
	);
});
