// The agent panel's projections: pure functions of the transcript rows.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { rowsOf, transcriptRow } from '../src/engine/agent/schema.ts';
import type { Json } from '../src/decl/values.ts';
import type { AgentRow } from '../src/protocol/wire.ts';
import {
	background,
	checkOf,
	checkpointSections,
	childStatus,
	contextView,
	currentPreview,
	doingOf,
	failedVerbs,
	failureOf,
	modelDividers,
	orbState,
	captionOf,
	previewsOf,
	reportView,
	revisable,
	runState,
	stepArgs,
	stepView
} from '../src/shell/agent/view.ts';
import type { StudioChangeSet, ToolBehavior } from '@norbital-ai/host-api';
import { checkFailing, NUDGE } from '../src/engine/agent/index.ts';

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

describe('the orb', () => {
	it('lets the caller override: a turn it just dispatched works, a send it saw fail outranks the status', () => {
		expect(orbState({ status: 'idle', rows: [reply(1)], pending: true })).toBe('working');
		expect(orbState({ status: 'running', rows: [], failed: true })).toBe('failed');
	});
});

it.effect(
	'a collected preview job retains its trusted Studio role; ordinary tool data cannot supply one',
	() =>
		Effect.gen(function* () {
			const completed = {
				job: 'j1',
				label: 'workspace_preview',
				studio: 'preview',
				result: { preview: 'https://preview.test/', commit: 'c1' }
			};
			const messages = ['wait', 'remote__read'].map((name, seq) => ({
				r: {
					id: `job-${seq}`,
					conversation: 'c',
					seq: seq + 1,
					role: 'tool',
					content: { id: `call-${seq}`, assistant: 'a1', name, result: { settled: completed } },
					text: null,
					state: null,
					mode: null,
					as: null,
					author: null,
					meta: null,
					supersedes: null,
					turn: 't'
				}
			}));
			const rows = yield* rowsOf(messages);
			const projected = rows.flatMap((row) => {
				const value = transcriptRow(row, true, false);
				return value === null ? [] : [value];
			});
			expect(previewsOf(projected)).toMatchObject([
				{ url: 'https://preview.test/', about: { commit: 'c1' } }
			]);
			expect(projected[1]?.tool?.studio).toBeUndefined();
		})
);

describe('source edits on the panel', () => {
	const edited = (
		name: string,
		args: Json,
		result: Json,
		behavior: ToolBehavior = { source_edit: true }
	) =>
		Effect.gen(function* () {
			const rows = yield* rowsOf([
				{
					r: {
						id: 'edit',
						conversation: 'c',
						seq: 1,
						role: 'tool',
						content: {
							id: 'call',
							assistant: 'a1',
							name,
							args: JSON.stringify(args),
							result,
							behavior
						},
						text: null,
						state: null,
						mode: null,
						as: null,
						author: null,
						meta: null,
						supersedes: null,
						turn: 't'
					}
				}
			]);
			const [one] = rows;
			return one === undefined ? null : transcriptRow(one, true, false);
		});
	it.effect("an edit's diff comes off its call, so its answer stays a path and diagnostics", () =>
		Effect.gen(function* () {
			const edit = yield* edited(
				'workspace_edit',
				{ path: 'src/a.ts', oldString: 'one\ntwo', newString: 'three' },
				'Edited src/a.ts (1 replacement)'
			);
			expect(edit?.tool?.changes).toEqual([{ path: 'src/a.ts', diff: '-one\n-two\n+three' }]);
			const write = yield* edited(
				'workspace_write',
				{ path: 'src/b.ts', content: 'a\nb' },
				'Created file successfully: src/b.ts'
			);
			expect(write?.tool?.changes).toEqual([{ path: 'src/b.ts', diff: '+a\n+b' }]);
		})
	);
	it.effect("a patch's files and hunks come off its call; its answer names the files only", () =>
		Effect.gen(function* () {
			const patch = yield* edited(
				'workspace_patch',
				{
					patchText: [
						'*** Begin Patch',
						'*** Add File: src/data/model/po/+model.ts',
						'+export {};',
						'*** Update File: src/a.ts',
						'*** Move to: src/b.ts',
						'@@ const a = 1;',
						' const a = 1;',
						'-const b = 2;',
						'+const b = 3;',
						'*** Delete File: src/c.ts',
						'*** End Patch'
					].join('\n')
				},
				'Success. Updated the following files:\nA src/data/model/po/+model.ts\nM src/b.ts\nD src/c.ts'
			);
			expect(patch?.tool?.changes).toEqual([
				{ path: 'src/data/model/po/+model.ts', diff: '+export {};', change: 'added' },
				{
					path: 'src/a.ts → src/b.ts',
					diff: '@@ const a = 1;\n const a = 1;\n-const b = 2;\n+const b = 3;',
					change: 'modified'
				},
				{ path: 'src/c.ts', diff: '', change: 'deleted' }
			]);
		})
	);
	it.effect(
		'a step whose tool declares no source edit shows no diff, whatever its name or input',
		() =>
			Effect.gen(function* () {
				const undeclared = yield* edited(
					'workspace_write',
					{ path: 'src/b.ts', content: 'a\nb' },
					'Created file successfully: src/b.ts',
					{}
				);
				expect(undeclared?.tool?.changes).toBeUndefined();
				const declared = yield* edited('anything', { path: 'src/b.ts', content: 'a' }, 'ok');
				expect(declared?.tool?.changes).toEqual([{ path: 'src/b.ts', diff: '+a' }]);
			})
	);
	it.effect(
		'historical source calls retain raw evidence without reviving the retired multi-file edit contract',
		() =>
			Effect.gen(function* () {
				const args = {
						changes: [
							{ path: 'src/a.ts', find: 'x', replace: 'y' },
							{ path: 'b.txt', text: 'z' }
						]
					},
					old = yield* edited('workspace_write', args, {
						changes: [{ path: 'src/a.ts', diff: '-x\n+y', change: 'modified' }]
					});
				expect(old?.tool?.changes).toBeUndefined();
				expect(old?.tool?.args).toBe(JSON.stringify(args));
			})
	);
	it("names each source tool in the person's words", () => {
		expect(stepView('workspace_read', { path: 'a.ts', offset: 10, limit: 50 })).toMatchObject({
			verb: 'Read source',
			target: 'a.ts:10-59'
		});
		expect(stepView('workspace_grep', { pattern: 'bolt', path: 'src' })).toMatchObject({
			verb: 'Searched the source',
			target: 'bolt in src'
		});
		expect(stepView('workspace_glob', { pattern: '**/*.ts' })).toMatchObject({
			verb: 'Found source files',
			target: '**/*.ts'
		});
	});
	it("reads a host tool's step by the view it declared, never by its name", () => {
		const view = {
			icon: 'lucide:git-commit-horizontal',
			verb: 'Committed',
			target: 'Add notes',
			doing: 'Committing…'
		};
		expect(stepView('workspace_commit', { message: 'Add notes' }, view)).toEqual({
			icon: 'lucide:git-commit-horizontal',
			verb: 'Committed',
			target: 'Add notes'
		});
		// undeclared, a host tool reads as its own name, whatever it is called
		expect(stepView('workspace_commit', { message: 'Add notes' })).toMatchObject({
			icon: 'lucide:wrench',
			target: ''
		});
		expect(stepView('workspace_commit', { message: 'Add notes' }).verb).not.toBe('Committed');
		// a host cannot restyle a native tool
		expect(stepView('workspace_read', { path: 'a.ts' }, view).verb).toBe('Read source');
		const running = (tool: NonNullable<AgentRow['tool']>) => row(1, { role: 'tool', tool });
		expect(
			doingOf([
				running({ name: 'workspace_commit', behavior: {}, failed: false, running: true, view })
			])
		).toBe('Committing…');
		expect(
			doingOf([running({ name: 'workspace_commit', behavior: {}, failed: false, running: true })])
		).toBe('Working…');
	});
	it('names each agent tool by its own name and input', () => {
		expect(stepView('read_file', { id: 'f1', crops: [[0, 0, 1, 1]] })).toMatchObject({
			verb: 'Zoomed into a page',
			target: '1 regions'
		});
		expect(stepView('read_file', { id: 'f1', image: 1 })).toMatchObject({
			verb: 'Viewed an image',
			target: ''
		});
		expect(stepView('read_output', { call: 'c1' }).verb).toBe('Read the full result');
		expect(stepView('task', { description: 'Review all', prompt: 'Review\nall' })).toMatchObject({
			verb: 'Started a subagent',
			target: 'Review all'
		});
		expect(stepView('task', { description: 'Go on', prompt: 'Go on', task_id: 'c' })).toMatchObject(
			{
				verb: 'Sent a message to a subagent',
				target: 'Go on'
			}
		);
		expect(stepView('task', { action: 'read', task_id: 'c' }).verb).toBe('Checked a subagent');
		expect(stepView('task', { action: 'stop', task_id: 'c' }).verb).toBe('Stopped a subagent');
		expect(stepView('read', { request: { $runs: { limit: 5 }, sys_audit_log: {} } }).target).toBe(
			'runs, sys audit log'
		);
	});
});

describe('the context view', () => {
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
	it('marks superseded user messages outside context and superseded', () => {
		const rows = [row(1), reply(2), row(3, { supersedes: 'm1' })];
		const view = contextView(rows, null);
		expect([...view.superseded]).toEqual(['m1']);
		expect([...view.outside]).toEqual(['m1']);
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
	it('keeps escaped checkpoint cells and leaves a lone table row in its original form', () => {
		const table =
			'| Row | Summary |\n|---|---|\n| Goal | One \\| two |\n| Invalid | Three | Cells |';
		expect(checkpointSections(table)).toBe('#### Goal\n\nOne | two');
		const lone = '| Goal | One \\| two |';
		expect(checkpointSections(lone)).toBe(lone);
	});
	it('revises posted user messages including their stored attachments', () => {
		expect(revisable(row(1))).toBe(true);
		expect(revisable(row(1, { files: [{ name: 'a.pdf', mime: 'application/pdf' }] }))).toBe(true);
		expect(revisable(reply(1))).toBe(false);
	});
});

describe('the model-change divider', () => {
	it('uses decoded reply usage and ignores usage carried by a user row', () => {
		expect([
			...modelDividers([
				reply(1, 'fast'),
				row(2, { usage: { input: 1, output: 1, calls: 1, model: 'strong' } }),
				reply(3),
				reply(4, 'fast'),
				reply(5, 'strong')
			])
		]).toEqual([['m5', 'strong']]);
	});
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

describe('subagent messages', () => {
	const conversation = '620df511-790d-4570-9d1e-1fddf492ba86';
	const report = (state: string, summary: string, body: string, id = conversation) =>
		`<task id="${id}" state="${state}">\n<summary>${summary}: Review "invoices"\nCheck totals</summary>\n<task_${state === 'error' ? 'error' : 'result'}>\n${body}\n</task_${state === 'error' ? 'error' : 'result'}>\n</task>`;
	it('requires report metadata even when the text resembles a report', () => {
		expect(
			reportView(row(1, { text: report('completed', 'Background task completed', 'Done') }))
		).toBeNull();
	});
	it('reads the task description and keeps the entire body, including quotes and newlines', () => {
		const message = 'Checked "October" invoices.\nTotals match.\n\nReady for review.';
		for (const [state, summary] of [
			['completed', 'Background task completed'],
			['error', 'Background task failed'],
			['cancelled', 'Background task cancelled']
		] as const)
			expect(
				reportView(row(1, { report: { conversation }, text: report(state, summary, message) }))
			).toEqual({
				icon: 'lucide:inbox',
				verb: 'Received a message',
				target: 'Review "invoices"',
				message
			});
	});
	it('identifies a question from its metadata', () => {
		const message = 'Which month should I use?\nThe draft has September and October.';
		expect(
			reportView(
				row(1, {
					report: { conversation, asked: true },
					text: report('question', 'Background task asks you', message)
				})
			)
		).toEqual({
			icon: 'lucide:message-circle-question',
			verb: 'Received a question',
			target: 'Review "invoices"',
			message
		});
	});
	it('preserves unexpected text or a mismatched conversation without inventing a task title', () => {
		for (const text of [
			'A report in another format.\nKeep every line.',
			report('completed', 'Background task completed', 'Done', 'another-conversation'),
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
			row(seq, { role: 'tool', tool: { behavior: {}, name: 'act', failed: false, ...t } });
		expect(
			background([
				row(1),
				tool(2, { name: 'task', child: 'c1' }),
				tool(3, { runs: ['r1', 'r2'] }),
				tool(4, { runs: ['r2'] }),
				tool(5, { name: 'task', child: 'c1' })
			])
		).toEqual([
			{ kind: 'agent', id: 'c1' },
			{ kind: 'run', id: 'r1' },
			{ kind: 'run', id: 'r2' }
		]);
	});
	it('reads a queued or waiting run as running and a skipped one as done', () => {
		expect(
			['queued', 'running', 'waiting', 'succeeded', 'skipped', 'failed', 'stopped'].map(runState)
		).toEqual(['running', 'running', 'running', 'done', 'done', 'failed', 'stopped']);
	});
});

describe('Studio outcomes outside the folded steps', () => {
	// a host's Studio tools by the roles they declare
	const ROLE = {
		workspace_preview: 'preview',
		browser: 'view',
		workspace_logs: 'logs',
		workspace_publish: 'merge',
		workspace_rollback: 'rollback'
	} as const;
	const tool = (name: string, result?: string, o: Partial<NonNullable<AgentRow['tool']>> = {}) => ({
		name,
		behavior: {},
		failed: false,
		...Object.fromEntries(
			Object.entries(ROLE)
				.filter(([n]) => n === name)
				.map(([, studio]) => ['studio', studio])
		),
		...(result === undefined ? {} : { result }),
		...o
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
				failed('browser', '{"download":"https://a.test/x"}', '{"error":"404"}')
			])
		).toEqual(['Downloaded']);
	});
	it('a check that ran reports what it found, not a failure; one that could not run is a failed step', () => {
		const found = '{"failing":2,"types":{"total":2,"diagnostics":[]}}',
			older = '{"error":"2 failing","types":{"total":2,"diagnostics":[]}}';
		for (const result of [found, older]) {
			const check = tool('workspace_diagnose', result, {
				behavior: { diagnostics: true },
				failed: result === older
			});
			expect(checkOf(check)).toEqual({ typeErrors: 2, testsFailed: false });
			expect(failureOf(check)).toBe('');
			expect(failedVerbs([row(1, { role: 'tool', tool: check })])).toEqual([]);
		}
		const broke = tool('workspace_diagnose', '{"error":"no graph in the package store"}', {
			failed: true
		});
		expect(checkOf(broke)).toBeNull();
		expect(failureOf(broke)).toBe('no graph in the package store');
		expect(checkFailing({ failing: 7, types: {} })).toBe(7);
		expect(checkFailing({ types: { total: 0 } })).toBe(0);
		expect(checkFailing({ error: 'The build did not start.' })).toBeUndefined();
	});
	it('a resumed turn quotes its open request, and names one without words instead of quoting ""', () => {
		expect(NUDGE.resumed(' Fix the roster \n')).toContain('still open: "Fix the roster".');
		expect(NUDGE.resumed('')).not.toContain('""');
		expect(NUDGE.resumed('  ')).toContain('their last message above');
	});
	it('the previewer shows built previews and the ones the agent chose among them, never another page', () => {
		const step = (seq: number, name: string, o: Partial<NonNullable<AgentRow['tool']>>) =>
			row(seq, { role: 'tool', tool: tool(name, '{}', o) });
		const about = { environment: 'Preview', commit: 'abc1234def', message: 'Rename title' };
		expect(
			previewsOf([
				step(1, 'page', { preview: 'https://a.test/early' }),
				step(2, 'workspace_preview', { preview: 'https://a.test/', about }),
				step(3, 'workspace_preview', { preview: 'https://b.test/', failed: true }),
				step(4, 'page', { preview: 'https://evil.test/' }),
				step(5, 'page', { preview: 'https://a.test/page' }),
				step(6, 'browser', { about: { ...about, url: 'https://c.test/' } })
			]).map((p) => p.url)
		).toEqual(['https://a.test/', 'https://a.test/page', 'https://c.test/']);
		// a bundle is its release when the step names one, else the step: the same bundle never reloads the frame
		expect(
			previewsOf([
				step(1, 'workspace_preview', { preview: 'https://a.test/', about: { release: 'r1' } }),
				step(2, 'workspace_preview', { preview: 'https://a.test/' })
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
		).toBe('Preview · Rename title · 390×844 · 23:05');
	});
	it('resolves a merged change to its published workspace without redirecting an unrelated preview', () => {
		const preview = { url: 'https://preview.test/', key: 'p1', about: { commit: 'c1' } };
		const change: StudioChangeSet = {
			id: '1',
			title: 'Build portal',
			state: 'merged',
			opened_by: 'u',
			contributors: [],
			branch: 'change-1',
			base: 'c0',
			head: 'c1',
			commits: [],
			behind: 0,
			preview: null,
			log: [],
			created_at: '',
			updated_at: ''
		};
		const state = {
			change_sets: [change],
			environments: [{ name: 'live', release: 'r1', url: 'https://live.test/' }],
			releases: [{ commit: 'c1', at: '', message: 'Build portal', current: true }]
		};
		expect(currentPreview(preview, state)).toMatchObject({
			url: 'https://live.test/',
			key: 'r1',
			about: { environment: 'live' }
		});
		expect(currentPreview(preview, { ...state, change_sets: [{ ...change, state: 'open' }] })).toBe(
			preview
		);
		expect(currentPreview({ ...preview, about: { commit: 'unrelated' } }, state).url).toBe(
			preview.url
		);
	});
	it.effect('a step whose answer is a held request names it in full, for the card to decide', () =>
		Effect.gen(function* () {
			const message = (seq: number, result: Json) => ({
				r: {
					id: `m${seq}`,
					conversation: 'c',
					seq,
					role: 'tool',
					content: {
						id: `k${seq}`,
						assistant: 'a1',
						name: 'workspace_merge',
						studio: 'merge',
						result
					},
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

it('a clipped atomic act still names its first write', () => {
	const clipped = '{"acts":{"trials.create":[{"project_id":"p1","sample_label":"8A","compo';
	expect(stepView('act', stepArgs(clipped)).verb).toBe('Create trials');
	expect(stepView('act', stepArgs('{"acts":{"projects.update":[]}}')).verb).toBe('Update projects');
});
