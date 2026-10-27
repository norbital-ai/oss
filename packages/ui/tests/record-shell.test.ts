import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import {
	viewFixture,
	jsonRecord,
	recordRootsOf,
	type ActOptions,
	type ViewScript,
	browser
} from './view-fixture.ts';
import { Deferred, Effect, Schema, Stream } from 'effect';
import { READ_LIMIT } from '../src/read/request.ts';
// The record shell's header chrome: the history scrubber (a past revision shows read-only, then back to current), the
// record/approval toggle for native proposals, and no per-field history or History tab.
import './dom.ts';
import assert from 'node:assert/strict';
import type { Json } from '@norbital-ai/std/wire';
import type { Value } from '@norbital-ai/std/kind';
import type { ApprovalView, Outcome } from '../src/client/contract.ts';
import type { RecordCapabilities } from '../src/record/types.ts';
import type { Row } from '../src/model/types.ts';
import type { KindsHost } from '../src/kinds/context.ts';
import type { RecordShellProps } from '../src/record/RecordShell.svelte';
import type { FormProps } from '../src/form/form.svelte';
import type { Checkpoint } from '../src/record/history.ts';
import type { Outcome as WireOutcome } from '../../bolt/build/protocol/schema.js';
import { it, afterEach } from '@effect/vitest';
import { vi } from 'vitest';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');

const catalog = {
	jobs: {
		label: ['title'],
		fields: { title: { kind: 'text' }, crew: { kind: 'text', optional: true } },
		update: { columns: ['title', 'crew'] }
	}
} satisfies NonNullable<KindsHost['catalog']>;
const LIVE = { id: 'j1', revision: 3, title: 'Paint v3', crew: 'B' };
const PAST: Record<number, Row> = {
	1: { id: 'j1', revision: 1, title: 'Paint', crew: null },
	2: {
		id: 'j1',
		revision: 2,
		title: 'Paint v2',
		crew: null,
		updated_at: '2026-09-02T00:00:00.000Z'
	}
};
type HistoryRow = Pick<Checkpoint, 'revision' | 'at' | 'actor'> & {
	changed: Readonly<Record<string, Json>>;
};
const HISTORY: readonly HistoryRow[] = [
	{
		revision: 1,
		at: '2026-09-01T00:00:00.000Z',
		actor: { kind: 'member', id: 'u1' },
		changed: { title: 'Paint' }
	},
	{
		revision: 2,
		at: '2026-09-02T00:00:00.000Z',
		actor: { kind: 'system', id: 'run1' },
		changed: { title: 'Paint v2', updated_at: 'x' }
	},
	{
		revision: 3,
		at: '2026-09-03T00:00:00.000Z',
		actor: { kind: 'member', id: 'u1' },
		changed: { title: 'Paint v3', crew: 'B' }
	}
];
const approvalView = (request: Partial<ApprovalView> & { id: string }): ApprovalView => ({
	model: 'jobs',
	record: 'j1',
	action: 'update',
	at: '2026-09-01T00:00:00Z',
	status: 'Pending',
	step: 0,
	steps: [{ name: 'Review', teams: ['reviewers'], users: [] }],
	superseded_by: [],
	teamNames: {},
	userNames: {},
	requestor: { ref: 'u1', name: 'Ada' },
	log: [],
	records: [{ model: 'jobs', id: 'j1', op: 'update' }],
	moves: [],
	mine: false,
	participant: true,
	...request
});
async function fake(
	live: Value,
	requests: readonly (Partial<ApprovalView> & { id: string })[] = []
) {
	const calls: {
		gets: { c: string; id: string; revision?: number; layers?: Readonly<Record<string, Json>> }[];
		history: number;
		acts: { callable: string; input: Json; options: ActOptions }[];
	} = { gets: [], history: 0, acts: [] };
	const fixture = await viewFixture({
		get: (c, id, layers, options) => {
			// a past revision is read as of the instant its history entry was written
			const revision = HISTORY.find((entry) => entry.at === options?.asOf)?.revision;
			calls.gets.push({
				c,
				id,
				...(revision === undefined ? {} : { revision }),
				...(layers === undefined ? {} : { layers })
			});
			return c === 'sys_user'
				? { id, name: 'Ada' }
				: revision !== undefined
					? (PAST[revision] ?? null)
					: live;
		},
		history: () => {
			calls.history++;
			return HISTORY;
		},
		act: (callable, input, options) => {
			calls.acts.push({ callable, input, options });
			return {
				kind: 'committed',
				output: null,
				records: [{ model: 'jobs', id: 'j1', revision: 4 }]
			};
		},
		approval: (params) =>
			params.has('id')
				? (() => {
						const found = requests.find((request) => request.id === params.get('id'));
						return found === undefined ? null : approvalView(found);
					})()
				: requests
						.filter(
							(request) =>
								params.get('all') === '1' ||
								request.status === 'Pending' ||
								request.status === 'ChangesRequested'
						)
						.map(approvalView)
	});
	return { ...fixture, calls };
}
const settle = async () => {
	flushSync();
	for (let i = 0; i < 5; i++) {
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
};
/** The in-app discard question (never `window.confirm`, which WebViews suppress): asked exactly once, then declined. */
const declineDiscard = async () => {
	const asking = () => [
		...document.querySelectorAll<HTMLElement>('[data-confirm-dialog][data-state=open]')
	];
	await vi.waitFor(() => assert.equal(asking().length, 1));
	const dialog = required(asking()[0]);
	assert.equal(dialog.getAttribute('role'), 'alertdialog');
	element<HTMLButtonElement>(dialog, '[data-confirm-cancel]').click();
	await vi.waitFor(() => assert.equal(asking().length, 0));
	await settle();
};
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of mounted.splice(0).reverse()) await close();
});
async function show(
	live: Value,
	shownCatalog: NonNullable<KindsHost['catalog']> = catalog,
	act?: ViewScript['act'],
	capabilities?: NonNullable<ViewScript['capabilities']>,
	requests: readonly (Partial<ApprovalView> & { id: string })[] = []
) {
	const { bolt, script, setCapabilities, calls } = await fake(live, requests);
	if (act !== undefined) script.act = act;
	if (capabilities !== undefined) setCapabilities(capabilities);
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, {
		target,
		props: { bolt, catalog: shownCatalog, part: 'record', props: { of: 'jobs', id: 'j1' } }
	});
	await settle();
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	return {
		target,
		calls,
		slider: () => document.querySelector<HTMLElement>('[data-record-timeline] [role=slider]'),
		openHistory: async () => {
			element<HTMLElement>(target, 'header [data-timeline-trigger]').click();
			await settle();
		}
	};
}
const key = async (el: Element | null, k: string) => {
	assert.ok(el);
	el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
	await settle();
};
const edit = (t: ParentNode) =>
	[...t.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b).trim() === 'Edit');

it.live('history loads lazily and exposes the selected revision accessibly', () =>
	Effect.gen(function* () {
		const v = yield* browser(() => show(LIVE));
		const trigger = element<HTMLElement>(v.target, 'header [data-timeline-trigger]');
		assert.ok(trigger, 'history opens from the sheet header');
		assert.equal(trigger.getAttribute('aria-label'), 'History');
		assert.equal(v.slider(), null, 'the ruler is hidden until opened');
		assert.equal(v.calls.history, 0, 'history loads lazily');
		yield* browser(() => v.openHistory());
		const s = v.slider();
		assert.ok(s);
		assert.ok(
			element<HTMLElement>(document, '[data-timeline-card="3"]'),
			'selected revision details remain visible without hover'
		);
		assert.equal(s.getAttribute('aria-valuemax'), '3');
		assert.equal(s.getAttribute('aria-valuenow'), '3');
	})
);

it.live('a past revision shows read-only, then End returns to the live, editable record', () =>
	Effect.gen(function* () {
		const v = yield* browser(() => show(LIVE));
		assert.ok(edit(v.target));
		yield* browser(() => v.openHistory());
		yield* browser(() => key(v.slider(), 'ArrowLeft'));
		assert.ok(
			v.calls.gets.some((g) => g.c === 'jobs' && g.revision === 2),
			'read as of revision 2'
		);
		assert.ok(element<HTMLElement>(v.target, '[data-record-past]'));
		assert.doesNotMatch(
			textOf(element<HTMLElement>(v.target, '[data-record-past]')),
			/2026-09-02T/,
			'historical notice uses a formatted time, not raw ISO'
		);
		assert.ok(element<HTMLElement>(v.target, 'fieldset[disabled]'));
		assert.match(textOf(element<HTMLElement>(v.target, '[data-field=title]')), /Paint v2/);
		assert.equal(edit(v.target), undefined, 'no Edit on a past revision');
		assert.equal(required(v.slider()).getAttribute('aria-valuenow'), '2');
		yield* browser(() => key(v.slider(), 'End'));
		assert.equal(v.target.querySelector('[data-record-past]'), null);
		assert.equal(v.target.querySelector('fieldset[disabled]'), null);
		assert.match(textOf(element<HTMLElement>(v.target, '[data-field=title]')), /Paint v3/);
		assert.ok(edit(v.target));
	})
);

it.live(
	'a past revision with changes offers Restore this version; its preview lists changes and skipped fields',
	() =>
		Effect.gen(function* () {
			const acts: { callable: string; input: Json; observed?: Readonly<Record<string, number>> }[] =
				[];
			const preview = (revision: number) => ({
				model: 'jobs',
				record: 'j1',
				revision,
				live: 3,
				changes:
					revision === 2
						? [{ field: 'title', current: 'Paint v3', restored: 'Paint v2', approval: false }]
						: [],
				skipped: [{ field: 'crew', reason: 'noGrant', current: 'B', restored: null }]
			});
			const v = yield* browser(() =>
				show(LIVE, catalog, (callable, input, options) => {
					acts.push({
						callable,
						input,
						...(options.observed === undefined ? {} : { observed: options.observed })
					});
					const asked = jsonRecord(input)['revision'];
					return callable === 'history.preview'
						? { kind: 'committed', output: preview(Number(asked)), records: [] }
						: {
								kind: 'committed',
								output: null,
								records: [{ model: 'jobs', id: 'j1', revision: 4 }]
							};
				})
			);
			yield* browser(() => v.openHistory());
			yield* browser(() => key(v.slider(), 'ArrowLeft'));
			assert.ok(
				!acts.some((a) => a.callable === 'history.preview'),
				'scrubbing alone reads no preview'
			);
			element<HTMLButtonElement>(v.target, '[data-record-past] [data-record-restore]').click();
			yield* browser(settle);
			const dialog = element<HTMLElement>(document, '[data-restore-preview="2"]');
			assert.match(textOf(element(dialog, '[data-restore-field=title]')), /Paint v3.*Paint v2/);
			const skipped = element<HTMLElement>(dialog, '[data-restore-skip=crew]');
			assert.equal(skipped.getAttribute('data-reason'), 'noGrant');
			assert.match(textOf(skipped), /You may not change this field/);
			element<HTMLButtonElement>(dialog, '[data-restore-confirm]').click();
			yield* browser(settle);
			assert.deepEqual(
				acts.filter((a) => a.callable === 'history.restore'),
				[
					{
						callable: 'history.restore',
						input: { model: 'jobs', record: 'j1', revision: 2 },
						observed: { j1: 3 }
					}
				]
			);
			assert.equal(v.target.querySelector('[data-record-past]'), null, 'back to the live record');
			// a revision whose preview writes nothing says so, and offers no confirm
			yield* browser(() => key(v.slider(), 'Home'));
			element<HTMLButtonElement>(v.target, '[data-record-past] [data-record-restore]').click();
			yield* browser(settle);
			const empty = element<HTMLElement>(document, '[data-restore-preview]');
			assert.ok(element(empty, '[data-restore-nothing]'));
			assert.equal(empty.querySelector('[data-restore-confirm]'), null);
		})
);

it.live(
	'opening history loads it once and the selected revision says when, who and what changed',
	() =>
		Effect.gen(function* () {
			const v = yield* browser(() => show(LIVE));
			yield* browser(() => v.openHistory());
			yield* browser(() => key(v.slider(), 'ArrowLeft'));
			const card = element<HTMLElement>(document, '[data-timeline-card="2"]');
			assert.ok(card);
			assert.equal(v.calls.history, 1);
			assert.match(textOf(card), /Automation/);
			assert.match(textOf(card), /Title/);
			assert.doesNotMatch(textOf(card), /Updated at/);
		})
);

const logEntry = (
	move: ApprovalView['log'][number]['move'],
	to: string,
	by: string,
	extra: Partial<ApprovalView['log'][number]> = {}
): ApprovalView['log'][number] => ({
	move,
	by: { ref: `member:${by}`, name: by },
	at: '2026-10-13T00:00:00Z',
	from: move === 'request' ? null : 'Pending',
	to,
	step: 0,
	reason: null,
	...extra
});

it.live('a held record shows Under approval and its request timeline, without a domain stamp', () =>
	Effect.gen(function* () {
		const v = yield* browser(() =>
			show(LIVE, catalog, undefined, undefined, [
				{
					id: 'r1',
					steps: [{ name: 'Review team', teams: ['reviewers'], users: [] }],
					teamNames: { reviewers: 'Review team' },
					mine: true,
					log: [logEntry('request', 'Pending', 'Ada')]
				}
			])
		);
		assert.match(textOf(element<HTMLElement>(v.target, '[data-record-head]')), /Under approval/);
		const approval = element<HTMLElement>(v.target, 'header [data-record-pane=approval]');
		approval.click();
		yield* browser(() => settle());
		assert.equal(approval.getAttribute('aria-pressed'), 'true');
		assert.ok(element<HTMLElement>(v.target, 'fieldset.hidden'), 'the record body stays mounted');
		assert.match(
			textOf(element<HTMLElement>(v.target, '[data-view=approval-timeline]')),
			/Requested/
		);
		assert.match(
			textOf(element<HTMLElement>(v.target, '[data-view=approval-timeline]')),
			/Review team/
		);
	})
);

it.live('a change request explains RFC and approval details on keyboard focus', () =>
	Effect.gen(function* () {
		const v = yield* browser(() =>
			show(LIVE, catalog, undefined, undefined, [
				{
					id: 'r1',
					status: 'ChangesRequested',
					log: [
						logEntry('request', 'Pending', 'Ada'),
						logEntry('requestChanges', 'ChangesRequested', 'Sam')
					]
				}
			])
		);
		const badge = element<HTMLElement>(v.target, '[data-view=approval-badge]');
		assert.equal(textOf(badge).trim(), 'RFC');
		assert.equal(badge.getAttribute('aria-label'), 'Request for change');
		assert.equal(badge.getAttribute('role'), 'status');
		assert.equal(badge.tabIndex, 0);
		yield* browser(async () => {
			badge.focus();
			await settle();
		});
		assert.match(
			textOf(element<HTMLElement>(document, '[data-slot=tooltip-content]')),
			/Request for change/
		);
		element<HTMLElement>(v.target, 'header [data-record-pane=approval]').click();
		yield* browser(settle);
		const step = element<HTMLElement>(v.target, '[data-step="step-0"] [data-node]');
		assert.match(step.getAttribute('aria-label') ?? '', /Changes requested/);
		step.focus();
		yield* browser(settle);
		assert.match(
			textOf(element<HTMLElement>(document, '[data-view=approval-step-log]')),
			/Requested changes/
		);
	})
);

it.live(
	'the record numbers its requests chronologically, opens the newest, and keeps past decisions readable',
	() =>
		Effect.gen(function* () {
			const v = yield* browser(() =>
				show(LIVE, catalog, undefined, undefined, [
					{
						id: 'r2',
						at: '2026-10-14T00:00:00Z',
						log: [logEntry('request', 'Pending', 'Ada')]
					},
					{
						id: 'r1',
						status: 'Rejected',
						at: '2026-10-13T00:00:00Z',
						log: [
							logEntry('request', 'Pending', 'Ada'),
							logEntry('reject', 'Rejected', 'Sam', { reason: 'Too costly' })
						]
					}
				])
			);
			element<HTMLElement>(v.target, 'header [data-record-pane=approval]').click();
			yield* browser(() => settle());
			const scope = element<HTMLSelectElement>(v.target, '[data-view=approval-scope]');
			assert.equal(scope.value, 'r2');
			assert.deepEqual(
				[...scope.options].map((option) => [option.value, textOf(option).split(' · ').slice(0, 2)]),
				[
					['r2', ['#2', 'Pending']],
					['r1', ['#1', 'Rejected']]
				]
			);
			scope.value = 'r1';
			scope.dispatchEvent(new Event('change', { bubbles: true }));
			yield* browser(() => settle());
			assert.equal(
				v.target.querySelectorAll('[data-view=approval][data-status=Rejected]').length,
				1
			);
			element<HTMLElement>(v.target, '[data-step="step-0"] [data-node]').focus();
			yield* browser(settle);
			assert.match(
				textOf(element<HTMLElement>(document, '[data-view=approval-step-log]')),
				/Too costly/
			);
			scope.value = 'r2';
			scope.dispatchEvent(new Event('change', { bubbles: true }));
			yield* browser(settle);
			assert.equal(
				v.target.querySelectorAll('[data-view=approval][data-status=Pending]').length,
				1
			);
		})
);

it.live('a completed approval remains readable from the record without a pending marker', () =>
	Effect.gen(function* () {
		const v = yield* browser(() =>
			show(LIVE, catalog, undefined, undefined, [
				{
					id: 'r1',
					status: 'Approved',
					log: [logEntry('request', 'Pending', 'Ada'), logEntry('approve', 'Approved', 'Sam')]
				}
			])
		);
		const approval = element<HTMLElement>(v.target, 'header [data-record-pane=approval]');
		assert.doesNotMatch(
			textOf(element<HTMLElement>(v.target, '[data-record-head]')),
			/Under approval/
		);
		approval.click();
		yield* browser(() => settle());
		element<HTMLElement>(v.target, '[data-step="step-0"] [data-node]').focus();
		yield* browser(settle);
		const log = element<HTMLElement>(document, '[data-view=approval-step-log]');
		assert.match(textOf(log), /Approved/);
		assert.match(textOf(log), /Sam/);
		assert.doesNotMatch(textOf(v.target), /No approval on this record/);
	})
);

it.live(
	'under the approval lock, Edit is disabled and the compact chip says who may change it',
	() =>
		Effect.gen(function* () {
			const held = {
				...LIVE,
				$approval: {
					requestId: 'r1',
					state: 'Pending',
					step: 0,
					steps: [
						{ name: 'Finance', teams: ['finance'], users: [] },
						{ name: 'Commercial', teams: ['commercial'], users: [] }
					],
					requestedBy: 'Ada'
				}
			};
			const reasons = ['underApproval'] as const;
			const v = yield* browser(() =>
				show(held, catalog, undefined, () => ({
					model: 'jobs',
					id: 'j1',
					revision: 3,
					fields: {
						title: { writable: false, proposal: false, reasons },
						crew: { writable: false, proposal: false, reasons }
					},
					update: { allowed: false, proposal: false, reasons },
					delete: { allowed: false, proposal: false, reasons },
					moves: {},
					proposalMoves: {}
				}))
			);
			const button = required(edit(v.target));
			assert.equal(button.disabled, true);
			assert.equal(button.title, 'Under approval: only Finance approvers may change it');
			assert.equal(v.target.querySelector('[data-view=approval-lock]'), null);
			assert.doesNotMatch(
				textOf(element<HTMLElement>(v.target, '[data-record-head]')),
				/Finance may change it/
			);
			const badge = element<HTMLElement>(v.target, '[data-view=approval-badge]');
			assert.equal(textOf(badge).trim(), 'Under approval');
			assert.equal(
				badge.getAttribute('aria-label'),
				'Under approval: only Finance approvers may change it'
			);
			assert.equal(badge.tabIndex, 0);
			yield* browser(async () => {
				badge.focus();
				await settle();
			});
			assert.match(
				textOf(element<HTMLElement>(document, '[data-slot=tooltip-content]')),
				/Under approval: only Finance approvers may change it/
			);
		})
);

it.live(
	'every stored record: both toggles and a one-tick scrubber on revision 1; approval says there is none',
	() =>
		Effect.gen(function* () {
			const v = yield* browser(() => show({ ...LIVE, revision: 1 }));
			yield* browser(() => v.openHistory());
			assert.ok(element<HTMLElement>(v.target, 'header [data-record-pane=record]'));
			const approval = element<HTMLElement>(v.target, 'header [data-record-pane=approval]');
			assert.ok(approval);
			assert.equal(
				approval.querySelector('.bg-brand'),
				null,
				'no pending dot without a pending request'
			);
			assert.equal(required(v.slider()).getAttribute('aria-valuemax'), '1');
			required(v.slider()).focus();
			yield* browser(() => settle());
			assert.match(
				document.querySelector('[data-timeline-card="1"]')?.textContent ?? '',
				/Created/
			);
			approval.click();
			yield* browser(() => settle());
			assert.match(textOf(v.target), /No approval on this record/);
		})
);

// A record's words are the catalog's: an enum or state by its catalog label, a relation by its target's label, never raw.
const WORDS: Record<string, string> = {
	'models.deals.fields.kind.sow': 'SOW',
	'models.deals.fields.channel.mail': 'Email'
};
const deals = {
	deals: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			kind: { kind: 'enum', values: ['sow', 'nda'] },
			channel: { kind: 'enum', values: ['mail'] }
		},
		relations: { client: { targets: ['clients'] } },
		layers: ['client'],
		update: { columns: ['title', 'kind', 'channel'] }
	},
	clients: { label: ['name'], fields: { name: { kind: 'text' } } }
} satisfies NonNullable<KindsHost['catalog']>;
const DEAL = { id: 'd1', revision: 1, title: 'Build', kind: 'sow', channel: 'mail', client: 'c1' };
async function mountDeal(
	fixture: { part: 'record'; props: RecordShellProps } | { part: 'form'; props: FormProps }
) {
	const { bolt, script, setCapabilities, calls } = await fake(DEAL);
	bolt.t = (k) => WORDS[k] ?? k;
	const get = script.get;
	// a select naming the relation reads its target nested, as the engine does
	script.get = (c, id, layers, options) =>
		layers?.client
			? (calls.gets.push({ c, id, layers }), { ...DEAL, client: { id: 'c1', name: 'Acme' } })
			: get(c, id, layers, options);
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog: deals, ...fixture } });
	await settle();
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	return { target, calls };
}

it.live(
	'a subtitle relation shows its target label in one read; enums show their catalog words',
	() =>
		Effect.gen(function* () {
			const { calls } = yield* browser(() =>
				mountDeal({
					part: 'record',
					props: { of: 'deals', id: 'd1', subtitle: ['kind', 'client'] }
				})
			);
			const sub = element<HTMLElement>(document, '[data-record-head] p');
			assert.equal(sub?.textContent, 'SOW · Acme');
			assert.equal(
				calls.gets.filter((g) => g.layers?.client).length,
				1,
				'one read for the subtitle relations'
			);
		})
);

it.live('the generated read view shows enum values by their catalog words', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() =>
			mountDeal({ part: 'record', props: { of: 'deals', id: 'd1' } })
		);
		assert.match(textOf(element<HTMLElement>(target, '[data-field=kind]')), /SOW/);
		assert.match(textOf(element<HTMLElement>(target, '[data-field=channel]')), /Email/);
	})
);

it.live('a readonly form shows enum values by their catalog words', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() =>
			mountDeal({ part: 'form', props: { of: 'deals', id: 'd1', readonly: true } })
		);
		assert.match(textOf(element<HTMLElement>(target, '[data-field=kind]')), /SOW/);
		assert.match(textOf(element<HTMLElement>(target, '[data-field=channel]')), /Email/);
	})
);

// A child line's money reads in its document's currency before the host stamps the line's own copy.
const lines = {
	quotes: {
		label: ['number'],
		fields: { number: { kind: 'text' }, currency: { kind: 'currency', optional: true } }
	},
	quote_lines: {
		label: ['name'],
		fields: {
			name: { kind: 'text' },
			currency: { kind: 'currency' },
			unit_price: { kind: 'money', currency: 'currency', scale: 4 }
		},
		relations: { quote_id: { targets: ['quotes'] } },
		create: { columns: ['quote_id', 'name', 'unit_price'] },
		update: { columns: ['unit_price'] }
	}
} satisfies NonNullable<KindsHost['catalog']>;
async function mountLine(props: FormProps, rows: Readonly<Record<string, Row>>) {
	const { bolt, script, setCapabilities } = await fake(null);
	script.get = (c, id) => rows[`${c}/${id}`] ?? null;
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog: lines, part: 'form', props } });
	await settle();
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	return target;
}
it.live('a new line under a quote prices in the quote currency', () =>
	Effect.gen(function* () {
		const target = yield* browser(() =>
			mountLine(
				{ of: 'quote_lines', mode: 'create', values: { quote_id: 'q1' } },
				{ 'quotes/q1': { id: 'q1', number: 'Q-1', currency: 'USD' } }
			)
		);
		assert.match(textOf(element<HTMLElement>(target, '[data-field=unit_price]')), /USD/);
	})
);
it.live('editing a line prices in the line own currency', () =>
	Effect.gen(function* () {
		const target = yield* browser(() =>
			mountLine(
				{ of: 'quote_lines', id: 'l1' },
				{
					'quote_lines/l1': {
						id: 'l1',
						name: 'A',
						currency: 'CNY',
						unit_price: '2.5',
						quote_id: 'q1'
					}
				}
			)
		);
		assert.match(textOf(element<HTMLElement>(target, '[data-field=unit_price]')), /CNY/);
	})
);

it.live('an automation form sends direct input and follows its admitted run', () =>
	Effect.gen(function* () {
		const inputs: Json[] = [];
		const outcomes: Outcome[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
				uuid: () => 'rename-run',
				act: (callable, input) => {
					assert.equal(callable, 'start');
					const request = Schema.decodeUnknownSync(
						Schema.Struct({
							automation: Schema.String,
							runs: Schema.Array(Schema.Struct({ id: Schema.String, input: Schema.Json }))
						})
					)(input);
					const first = request.runs[0];
					assert.ok(first);
					inputs.push(first.input);
					return {
						kind: 'committed',
						output: {
							id: first.id,
							ids: request.runs.map((run) => run.id),
							automation: request.automation
						},
						records: []
					};
				},
				runs: (automation, options) => {
					assert.equal(automation, 'rename_job');
					assert.deepEqual(options, { where: { id: { eq: 'rename-run' } }, limit: 1 });
					return Stream.succeed({
						rows: [{ id: 'rename-run', automation, status: 'running' }],
						next: null
					});
				}
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog: {},
				automations: {
					rename_job: { input: { target: { kind: 'id', of: 'jobs' }, title: { kind: 'text' } } }
				},
				part: 'form',
				props: {
					of: { automation: 'rename_job' },
					values: { target: 'j1', title: 'Paint' },
					fields: ['title'],
					onOutcome: (outcome) => outcomes.push(outcome)
				}
			}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(() => settle());
		assert.equal(element<HTMLInputElement>(target, '[data-field=title] input').value, 'Paint');
		assert.equal(target.querySelector('[data-field=target]'), null);
		assert.equal(textOf(element<HTMLButtonElement>(target, 'button[type=submit]')).trim(), 'Start');
		element<HTMLFormElement>(target, 'form').dispatchEvent(
			new Event('submit', { bubbles: true, cancelable: true })
		);
		yield* browser(() => settle());
		assert.deepEqual(inputs, [{ target: 'j1', title: 'Paint' }]);
		assert.deepEqual(outcomes, [
			{
				kind: 'committed',
				output: { id: 'rename-run', ids: ['rename-run'], automation: 'rename_job' },
				records: []
			}
		]);
		assert.equal(element<HTMLElement>(target, '[data-run="rename-run"]').dataset.status, 'running');
	})
);

it.live('a create is headed "New <singular>", never the model label', () =>
	Effect.gen(function* () {
		const { bolt, script, setCapabilities } = yield* browser(() => fake(null));
		const target = document.createElement('div');
		document.body.append(target);
		const app = mount(Harness, {
			target,
			props: { bolt, catalog, part: 'record', props: { of: 'jobs', mode: 'create' } }
		});
		yield* browser(() => settle());
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		assert.equal(textOf(element<HTMLElement>(document, '[data-record-head] h2')).trim(), 'New job');
	})
);

it.live('authored record fields restrict read relations and the subsequent edit form', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() =>
			mountDeal({
				part: 'record',
				props: {
					of: 'deals',
					id: 'd1',
					fields: ['title'],
					sections: [{ name: 'main', title: 'Details', fields: ['title'] }]
				}
			})
		);
		assert.ok(element<HTMLElement>(target, '[data-field=title]'));
		assert.equal(target.querySelector('[data-field=kind]'), null);
		assert.equal(target.querySelector('[data-field=channel]'), null);
		assert.equal(
			target.querySelector('[data-field=client]'),
			null,
			'an omitted relation must not be appended'
		);
		required(edit(target)).click();
		yield* browser(() => settle());
		assert.ok(element<HTMLInputElement>(target, 'input[id$="-title"]'));
		assert.equal(target.querySelector('[data-field=kind]'), null);
		assert.equal(target.querySelector('[data-field=channel]'), null);
		assert.equal(target.querySelector('[data-field=client]'), null);
	})
);

it.live(
	'an explicitly selected relation appears once by its customer label without a section',
	() =>
		Effect.gen(function* () {
			const { bolt, script, setCapabilities } = yield* browser(() => fake(DEAL));
			const read = script.read;
			script.read = (c, options) =>
				c === 'clients' ? { rows: [{ id: 'c1', name: 'Acme' }], next: null } : read(c, options);
			const get = script.get;
			script.get = (c, id, select, options) =>
				c === 'clients' ? { id, name: 'Acme' } : get(c, id, select, options);
			const target = document.createElement('div');
			document.body.append(target);
			const app = mount(Harness, {
				target,
				props: {
					bolt,
					catalog: deals,
					part: 'record',
					props: { of: 'deals', id: 'd1', fields: ['title', 'client'] }
				}
			});
			mounted.push(async () => {
				await unmount(app);
				target.remove();
			});
			yield* browser(() => settle());
			assert.equal(target.querySelectorAll<HTMLElement>('[data-field=client]').length, 1);
			assert.match(textOf(element<HTMLElement>(target, '[data-field=client]')), /Acme/);
			assert.doesNotMatch(textOf(element<HTMLElement>(target, '[data-field=client]')), /c1/);
			assert.equal(target.querySelector('[data-field=kind]'), null);
		})
);

it.live(
	'a live state transition locks an open form without discarding its permitted unsaved draft',
	() =>
		Effect.gen(function* () {
			let current = { id: 'j1', revision: 1, title: 'Agreement', crew: 'A', status: 'draft' };
			const readers = new Set<() => void>();
			const { bolt, script, setCapabilities } = yield* browser(() => fake(current));
			const originalLiveGet = script.get;
			script.get = (c, id, select, options) =>
				c === 'jobs' && options?.asOf === undefined
					? current
					: originalLiveGet(c, id, select, options);
			script.changes = (read, emit) => {
				if (recordRootsOf(read).includes('jobs')) {
					readers.add(emit);
					return () => {
						readers.delete(emit);
					};
				}
				return () => {};
			};
			const rules: NonNullable<KindsHost['catalog']> = {
				jobs: {
					...catalog.jobs,
					fields: {
						...catalog.jobs.fields,
						status: {
							kind: 'state',
							initial: 'draft',
							states: {
								draft: { to: ['confirmed'] },
								confirmed: { to: ['closed'], edit: ['crew'] },
								closed: { edit: 'none' }
							}
						}
					}
				}
			};
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: { bolt, catalog: rules, part: 'record', props: { of: 'jobs', id: 'j1' } }
			});
			mounted.push(async () => {
				await unmount(app);
				target.remove();
			});
			yield* browser(() => settle());
			required(edit(target)).click();
			yield* browser(() => settle());
			const crew = element<HTMLInputElement>(target, '[data-field="crew"] input');
			crew.value = 'Unsaved crew';
			crew.dispatchEvent(new Event('input', { bubbles: true }));
			yield* browser(() => settle());
			current = { ...current, revision: 2, status: 'confirmed' };
			for (const reader of readers) reader();
			yield* browser(() => settle());
			assert.equal(
				element<HTMLElement>(target, '[data-field="title"]').hasAttribute('data-readonly'),
				true
			);
			assert.equal(
				element<HTMLInputElement>(target, '[data-field="crew"] input').value,
				'Unsaved crew'
			);
			current = { ...current, revision: 3, status: 'closed' };
			for (const reader of readers) reader();
			yield* browser(() => settle());
			assert.equal(
				element<HTMLElement>(target, '[data-field="crew"]').hasAttribute('data-readonly'),
				true
			);
			assert.equal(
				[...target.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].length,
				0
			);
		})
);

it.live(
	'native history merges scoped related records without masked field names and keeps its scrubber',
	() =>
		Effect.gen(function* () {
			const { bolt, script, setCapabilities, calls } = yield* browser(() => fake(LIVE));
			let query: import('./view-fixture.ts').ReadOptions | undefined;
			script.read = (c, o) => {
				query = o;
				return { rows: [{ id: 'a1', title: 'Customer call' }], next: null };
			};
			script.history = (c, id) =>
				c === 'jobs'
					? HISTORY
					: [
							{
								revision: 2,
								at: '2026-09-04T00:00:00.000Z',
								actor: { kind: 'member', id: 'u1' },
								changed: { title: 'Customer call', secret: { $masked: true } }
							}
						];
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: {
					bolt,
					catalog: {
						...catalog,
						activities: {
							label: ['title'],
							fields: { title: { kind: 'text' }, secret: { kind: 'text' } }
						}
					},
					part: 'record',
					props: {
						of: 'jobs',
						id: 'j1',
						history: {
							sources: [{ of: 'activities', where: { job: { eq: 'j1' } } }]
						}
					}
				}
			});
			mounted.push(async () => {
				await unmount(app);
				target.remove();
			});
			yield* browser(() => settle());
			element<HTMLElement>(target, '[data-timeline-trigger]').click();
			yield* browser(() => settle());
			assert.deepEqual(query, { where: { job: { eq: 'j1' } }, limit: READ_LIMIT });
			const events = element<HTMLElement>(document, '[data-record-history-events]');
			assert.match(textOf(events), /Customer call/);
			assert.match(textOf(events), /Ada/);
			assert.doesNotMatch(textOf(events), /Secret/);
			const firstEvent = required(events.firstElementChild);
			assert.ok(firstEvent instanceof HTMLElement);
			assert.equal(firstEvent.dataset.historyModel, 'activities');
			assert.ok(element<HTMLElement>(document, '[data-record-timeline] [role=slider]'));
		})
);

it.live('history timestamps use the host zone, matching record metadata', () =>
	Effect.gen(function* () {
		const { bolt } = yield* browser(() => fake(LIVE));
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog,
				zone: 'Asia/Singapore',
				part: 'record',
				props: { of: 'jobs', id: 'j1' }
			}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(() => settle());
		element<HTMLElement>(target, '[data-timeline-trigger]').click();
		yield* browser(() => settle());
		const expected = new Date(required(required(HISTORY[2]).at)).toLocaleString('en', {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: 'Asia/Singapore'
		});
		assert.ok(textOf(element<HTMLElement>(document, '[data-record-timeline]')).includes(expected));
		assert.ok(
			textOf(element<HTMLElement>(document, '[data-record-history-events]')).includes(expected)
		);
	})
);

it.live('editing keeps readable nonwritable fields visible without exposing an editor', () =>
	Effect.gen(function* () {
		const v = yield* browser(() =>
			show(LIVE, { jobs: { ...catalog.jobs, update: { columns: ['title'] } } })
		);
		required(edit(v.target)).click();
		yield* browser(() => settle());
		assert.ok(element<HTMLInputElement>(v.target, '[data-field=title] input'));
		const crew = element<HTMLElement>(v.target, '[data-field=crew]');
		assert.ok(crew, 'the readable field stays in the edit layout');
		assert.ok(crew.hasAttribute('data-readonly'));
		assert.match(textOf(crew), /B/);
		assert.equal(crew.querySelector('input, textarea, select'), null);
	})
);

it.live(
	'save carries the loaded draft revision and Cancel refuses to discard an unsaved edit silently',
	() =>
		Effect.gen(function* () {
			const v = yield* browser(() => show(LIVE));
			required(edit(v.target)).click();
			yield* browser(() => settle());
			const input = element<HTMLInputElement>(v.target, '[data-field=title] input');
			input.value = 'A changed title';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			yield* browser(() => settle());
			required(
				[...v.target.querySelectorAll<HTMLButtonElement>('button')].find(
					(b) => textOf(b).trim() === 'Cancel'
				)
			).click();
			yield* browser(() => declineDiscard());
			assert.equal(
				element<HTMLInputElement>(v.target, '[data-field=title] input').value,
				'A changed title'
			);
			element<HTMLElement>(v.target, 'form').dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true })
			);
			yield* browser(() => settle());
			assert.deepEqual(required(v.calls.acts[0]).options.observed, { j1: 3 });
			assert.deepEqual(required(v.calls.acts[0]).input, [
				{ target: 'j1', set: { title: 'A changed title' } }
			]);
		})
);

it.live('closing the sheet while saving asks before removing the pending draft', () =>
	Effect.gen(function* () {
		const work = yield* Deferred.make<WireOutcome>();
		const v = yield* browser(() => show(LIVE, catalog, () => Deferred.await(work)));
		required(edit(v.target)).click();
		yield* browser(() => settle());
		const input = element<HTMLInputElement>(v.target, '[data-field=title] input');
		input.value = 'Pending title';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		element<HTMLElement>(v.target, 'form').dispatchEvent(
			new Event('submit', { bubbles: true, cancelable: true })
		);
		yield* browser(() => settle());
		assert.equal(element<HTMLElement>(v.target, 'form').getAttribute('aria-busy'), 'true');
		try {
			element<HTMLElement>(v.target, '[data-sheet-close]').click();
			yield* browser(() => declineDiscard());
			assert.ok(element<HTMLElement>(v.target, 'form[aria-busy=true]'));
		} finally {
			yield* Deferred.succeed(work, {
				kind: 'committed',
				output: null,
				records: [{ model: 'jobs', id: 'j1', revision: 4 }]
			});
			yield* browser(() => settle());
		}
	})
);

it.live(
	'source-managed fields retain their value and explain the native restriction while local fields edit',
	() =>
		Effect.gen(function* () {
			const v = yield* browser(() =>
				show(LIVE, { jobs: { ...catalog.jobs, readonlyFields: { crew: 'syncOwned' } } })
			);
			required(edit(v.target)).click();
			yield* browser(() => settle());
			assert.ok(element<HTMLInputElement>(v.target, '[data-field=title] input'));
			const crew = element<HTMLElement>(v.target, '[data-field=crew]');
			assert.match(textOf(crew), /B/);
			assert.match(
				textOf(element<HTMLElement>(crew, '[data-field-restriction]')),
				/Managed by a sync/
			);
			assert.equal(crew.querySelector('input'), null);
		})
);

it.live('custom representation forms share the shell view/edit mode, draft and one save', () =>
	Effect.gen(function* () {
		const { default: Custom } = yield* browser(() => import('./record-custom-harness.svelte'));
		const { bolt, script, setCapabilities, calls } = yield* browser(() => fake(LIVE));
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Custom, { target, props: { bolt, catalog } });
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(() => settle());
		assert.equal(target.querySelector('input'), null, 'custom forms start in view mode');
		assert.equal(element<HTMLElement>(target, '[data-record-mode]').dataset.recordMode, 'view');
		assert.match(textOf(element<HTMLElement>(target, '[data-custom-title]')), /Paint v3/);
		required(edit(target)).click();
		yield* browser(() => settle());
		assert.equal(element<HTMLElement>(target, '[data-record-mode]').dataset.recordMode, 'edit');
		assert.equal(
			[...target.querySelectorAll<HTMLButtonElement>('button')].filter(
				(button) => textOf(button).trim() === 'Save'
			).length,
			1,
			'matching custom forms delegate Save to the record header'
		);
		assert.equal(
			target.querySelectorAll<HTMLElement>('[data-form-footer]').length,
			0,
			'each form does not repeat the header action'
		);
		for (const [field, value] of [
			['title', 'Shared title'],
			['crew', 'Shared crew']
		] as const) {
			const input = element<HTMLInputElement>(target, `[data-field=${field}] input`);
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		yield* browser(() => settle());
		const save = [...target.querySelectorAll<HTMLButtonElement>('[data-record-head] button')].find(
			(b) => textOf(b).trim() === 'Save'
		);
		assert.ok(save);
		save.click();
		yield* browser(() => settle());
		assert.equal(calls.acts.length, 1);
		assert.deepEqual(required(calls.acts[0]).input, [
			{ target: 'j1', set: { title: 'Shared title', crew: 'Shared crew' } }
		]);
		assert.deepEqual(required(calls.acts[0]).options.observed, { j1: 3 });
		assert.equal(target.querySelector('input'), null, 'committed save returns every form to view');
		assert.equal(element<HTMLElement>(target, '[data-record-mode]').dataset.recordMode, 'view');
	})
);

it.live(
	'returning from history preserves an unsaved draft and its original revision across a live update',
	() =>
		Effect.gen(function* () {
			let current = LIVE;
			const readers = new Set<() => void>();
			const { bolt, script, setCapabilities, calls } = yield* browser(() => fake(current));
			const originalLiveGet = script.get;
			script.get = (c, id, select, options) =>
				c === 'jobs' && options?.asOf === undefined
					? current
					: originalLiveGet(c, id, select, options);
			script.changes = (read, emit) => {
				if (recordRootsOf(read).includes('jobs')) {
					readers.add(emit);
					return () => {
						readers.delete(emit);
					};
				}
				return () => {};
			};
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: { bolt, catalog, part: 'record', props: { of: 'jobs', id: 'j1' } }
			});
			mounted.push(async () => {
				await unmount(app);
				target.remove();
			});
			yield* browser(() => settle());
			required(edit(target)).click();
			yield* browser(() => settle());
			const input = element<HTMLInputElement>(target, '[data-field=title] input');
			input.value = 'Unsaved draft';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			element<HTMLElement>(target, '[data-timeline-trigger]').click();
			yield* browser(() => settle());
			yield* browser(() =>
				key(element<HTMLElement>(document, '[data-record-timeline] [role=slider]'), 'ArrowLeft')
			);
			assert.match(textOf(element<HTMLElement>(target, '[data-field=title]')), /Paint v2/);
			current = { ...LIVE, revision: 4, title: 'Concurrent title' };
			for (const reader of readers) reader();
			yield* browser(() => settle());
			yield* browser(() =>
				key(element<HTMLElement>(document, '[data-record-timeline] [role=slider]'), 'End')
			);
			assert.equal(
				element<HTMLInputElement>(target, '[data-field=title] input').value,
				'Unsaved draft'
			);
			element<HTMLFormElement>(target, 'form').dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true })
			);
			yield* browser(() => settle());
			assert.deepEqual(
				required(calls.acts.find((a) => a.callable === 'jobs.update')).options.observed,
				{ j1: 3 }
			);
		})
);

const nativeCapabilities: RecordCapabilities = {
	model: 'jobs',
	id: 'j1',
	revision: 3,
	fields: {
		title: { writable: true, proposal: false, reasons: [] },
		crew: { writable: false, proposal: false, reasons: ['stateLocked'] }
	},
	update: { allowed: true, proposal: false, reasons: [] },
	delete: { allowed: false, proposal: false, reasons: ['noGrant'] },
	moves: {},
	proposalMoves: {}
};

it.live('native row capabilities govern editing and explain partially writable fields', () =>
	Effect.gen(function* () {
		const v = yield* browser(() => show(LIVE, catalog, undefined, async () => nativeCapabilities));
		assert.ok(edit(v.target));
		assert.equal(v.target.querySelector('[data-field-restriction]') === null, true);
		required(edit(v.target)).click();
		yield* browser(() => settle());
		assert.ok(element<HTMLInputElement>(v.target, '[data-field=title] input'));
		const crew = element<HTMLElement>(v.target, '[data-field=crew]');
		assert.equal(crew.querySelector('input'), null);
		assert.match(
			textOf(element<HTMLElement>(crew, '[data-field-restriction=stateLocked]')),
			/current state/
		);
	})
);

it.live('read-only viewing omits permission hints and editing explains denied fields', () =>
	Effect.gen(function* () {
		const denied: RecordCapabilities = {
			...nativeCapabilities,
			fields: {
				...nativeCapabilities.fields,
				crew: { writable: false, proposal: false, reasons: ['noGrant'] }
			}
		};
		const v = yield* browser(() => show(LIVE, catalog, undefined, async () => denied));
		assert.match(textOf(element<HTMLElement>(v.target, '[data-field=crew]')), /B/);
		assert.equal(v.target.querySelector('[data-field-restriction=noGrant]'), null);
		required(edit(v.target)).click();
		yield* browser(() => settle());
		assert.equal(v.target.querySelector('[data-field=crew] input'), null);
		assert.match(
			textOf(element<HTMLElement>(v.target, '[data-field-restriction=noGrant]')),
			/permissions/
		);
	})
);

it.live('native operation restrictions hide Edit while preserving readable values', () =>
	Effect.gen(function* () {
		const locked: RecordCapabilities = {
			...nativeCapabilities,
			fields: {
				title: { writable: false, proposal: false, reasons: ['stateLocked'] },
				crew: { writable: false, proposal: false, reasons: ['stateLocked'] }
			},
			update: { allowed: false, proposal: false, reasons: ['stateLocked'] }
		};
		const v = yield* browser(() => show(LIVE, catalog, undefined, async () => locked));
		assert.equal(edit(v.target), undefined);
		assert.match(textOf(element<HTMLElement>(v.target, '[data-field=title]')), /Paint v3/);
		assert.equal(v.target.querySelector('[data-field-restriction]') === null, true);
	})
);

for (const direct of [false, true])
	it.live(
		`a proposal field requests approval while locked fields remain readable (other direct fields: ${direct})`,
		() =>
			Effect.gen(function* () {
				const proposal: RecordCapabilities = {
					...nativeCapabilities,
					fields: {
						title: { writable: false, proposal: true, reasons: ['noGrant'] },
						crew: { writable: false, proposal: false, reasons: ['syncOwned'] },
						...(direct ? { note: { writable: true, proposal: false, reasons: [] } } : {})
					},
					update: { allowed: direct, proposal: true, reasons: direct ? [] : ['noGrant'] },
					proposalMoves: {}
				};
				const v = yield* browser(() =>
					show(
						LIVE,
						catalog,
						(callable, input, options) => {
							v.calls.acts.push({ callable, input, options });
							return { kind: 'pendingApproval', requestId: 'approval1', records: [] };
						},
						async () => proposal
					)
				);
				required(edit(v.target)).click();
				yield* browser(() => settle());
				const title = element<HTMLInputElement>(v.target, '[data-field=title] input');
				assert.ok(title);
				assert.equal(v.target.querySelector('[data-field=crew] input'), null);
				title.value = 'Proposed title';
				title.dispatchEvent(new Event('input', { bubbles: true }));
				yield* browser(() => settle());
				const request = [...v.target.querySelectorAll<HTMLButtonElement>('button')].find(
					(button) => textOf(button).trim() === 'Request approval'
				);
				assert.ok(request);
				request.click();
				yield* browser(() => settle());
				assert.deepEqual(required(v.calls.acts[0]).options.observed, { j1: 3 });
				assert.deepEqual(required(v.calls.acts[0]).input, [
					{ target: 'j1', set: { title: 'Proposed title' } }
				]);
				assert.equal(v.target.querySelector('[data-field=title] input'), null);
				assert.match(textOf(element<HTMLElement>(v.target, '[data-field=title]')), /Paint v3/);
			})
	);

it.live('a standalone update Form also applies native proposal and field restrictions', () =>
	Effect.gen(function* () {
		const { bolt, script, setCapabilities, calls } = yield* browser(() => fake(LIVE));
		setCapabilities(async () => ({
			...nativeCapabilities,
			fields: {
				title: { writable: false, proposal: true, reasons: ['noGrant'] },
				crew: { writable: false, proposal: false, reasons: ['syncOwned'] }
			},
			update: { allowed: false, proposal: true, reasons: ['noGrant'] },
			proposalMoves: {}
		}));
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog,
				part: 'form',
				props: { of: 'jobs', id: 'j1', mode: 'update', record: LIVE }
			}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(() => settle());
		assert.ok(element<HTMLInputElement>(target, '[data-field=title] input'));
		assert.equal(target.querySelector('[data-field=crew] input'), null);
		const title = element<HTMLInputElement>(target, '[data-field=title] input');
		title.value = 'Standalone proposal';
		title.dispatchEvent(new Event('input', { bubbles: true }));
		yield* browser(() => settle());
		assert.match(
			textOf(element<HTMLButtonElement>(target, 'button[type=submit]')),
			/Request approval/
		);
		element<HTMLFormElement>(target, 'form').dispatchEvent(
			new Event('submit', { bubbles: true, cancelable: true })
		);
		yield* browser(() => settle());
		assert.deepEqual(required(calls.acts[0]).options.observed, { j1: 3 });
	})
);

it.live(
	'unreadable native capabilities omit record fields; request failures prevent editing and show a recovery error',
	() =>
		Effect.gen(function* () {
			const missing = yield* browser(() => show(LIVE, catalog, undefined, async () => null));
			assert.equal(missing.target.querySelector('[data-field]'), null);
			assert.match(textOf(missing.target), /Not found or no access/);
			const failed = yield* browser(() =>
				show(LIVE, catalog, undefined, async () => {
					throw new Error('unavailable');
				})
			);
			assert.equal(edit(failed.target), undefined);
			assert.match(
				textOf(element<HTMLElement>(failed.target, '[role=alert]')),
				/Record permissions could not be loaded/
			);
		})
);

it.live(
	'an older permissions answer cannot reopen a record after a newer unreadable revision',
	() =>
		Effect.gen(function* () {
			let current = LIVE;
			const readers = new Set<() => void>();
			const answers: ((answer: RecordCapabilities | null) => void)[] = [];
			const { bolt, script, setCapabilities } = yield* browser(() => fake(current));
			setCapabilities(() => new Promise((resolve) => answers.push(resolve)));
			const originalLiveGet = script.get;
			script.get = (c, id, select, options) =>
				c === 'jobs' && options?.asOf === undefined
					? current
					: originalLiveGet(c, id, select, options);
			script.changes = (read, emit) => {
				if (recordRootsOf(read).includes('jobs')) {
					readers.add(emit);
					return () => {
						readers.delete(emit);
					};
				}
				return () => {};
			};
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: { bolt, catalog, part: 'record', props: { of: 'jobs', id: 'j1' } }
			});
			mounted.push(async () => {
				await unmount(app);
				target.remove();
			});
			yield* browser(() => settle());
			assert.equal(answers.length, 1);
			current = { ...LIVE, revision: 4 };
			for (const reader of readers) reader();
			yield* browser(() => settle());
			assert.equal(answers.length, 2);
			required(answers[1])(null);
			yield* browser(() => settle());
			required(answers[0])(nativeCapabilities);
			yield* browser(() => settle());
			assert.equal(target.querySelector('[data-field]'), null);
			assert.equal(edit(target), undefined);
			assert.match(textOf(target), /Not found or no access/);
		})
);

it.live('a routed create settles pending approval and opens the record it committed', () =>
	Effect.gen(function* () {
		const { bolt, script } = yield* browser(() => fake(null, []));
		const acts: string[] = [];
		script.act = (callable) => {
			acts.push(callable);
			return {
				kind: 'pendingApproval',
				requestId: 'r1',
				records: [{ model: 'jobs', id: 'candidate', revision: 1 }]
			};
		};
		history.replaceState(null, '', '/');
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog: { jobs: { ...catalog.jobs, create: { columns: ['title'] } } },
				part: 'record',
				props: { of: 'jobs', mode: 'create' }
			}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(() => settle());
		const input = element<HTMLInputElement>(target, '[data-field=title] input');
		input.value = 'Candidate job';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		yield* browser(() => settle());
		element<HTMLFormElement>(target, 'form').dispatchEvent(
			new Event('submit', { bubbles: true, cancelable: true })
		);
		yield* browser(() => settle());
		assert.deepEqual(acts, ['jobs.create']);
		assert.deepEqual(new URL(location.href).searchParams.getAll('record'), ['jobs/candidate']);
	})
);

it.live(
	'a create rolled back by rejection keeps its request readable instead of a missing-record error',
	() =>
		Effect.gen(function* () {
			const { bolt, setCapabilities } = yield* browser(() =>
				fake(null, [
					{
						id: 'create-request',
						record: 'candidate',
						action: 'create',
						status: 'Rejected',
						records: [{ model: 'jobs', id: 'candidate', op: 'create' }],
						log: [
							logEntry('request', 'Pending', 'Ada'),
							logEntry('reject', 'Rejected', 'Sam', {
								rolledBack: [{ model: 'jobs', id: 'candidate', action: 'removed' }]
							})
						]
					}
				])
			);
			setCapabilities(async () => {
				throw new Error('A removed create has no stored record capabilities');
			});
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: { bolt, catalog, part: 'record', props: { of: 'jobs', id: 'candidate' } }
			});
			try {
				yield* browser(() => settle());
				assert.equal(target.querySelector('[data-read=notFound]'), null);
				element<HTMLElement>(target, '[data-step="step-0"] [data-node]').focus();
				yield* browser(settle);
				const log = element<HTMLElement>(document, '[data-view=approval-step-log]');
				assert.match(textOf(log), /Rejected/);
				assert.match(textOf(element<HTMLElement>(log, '[data-rolled-back]')), /removed/);
				assert.equal(edit(target), undefined);
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);

it.live(
	'a late approval list cannot restore a request after a newer record revision has cleared it',
	() =>
		Effect.gen(function* () {
			let current = LIVE;
			const readers = new Set<() => void>();
			const answers: ((answer: readonly ApprovalView[]) => void)[] = [];
			const { bolt, script, setCapabilities } = yield* browser(() => fake(current));
			script.approval = (params) =>
				params.has('id')
					? null
					: new Promise<readonly ApprovalView[]>((resolve) => answers.push(resolve));
			const originalLiveGet = script.get;
			script.get = (c, id, select, options) =>
				c === 'jobs' && options?.asOf === undefined
					? current
					: originalLiveGet(c, id, select, options);
			script.changes = (read, emit) => {
				if (recordRootsOf(read).includes('jobs')) {
					readers.add(emit);
					return () => {
						readers.delete(emit);
					};
				}
				return () => {};
			};
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: { bolt, catalog, part: 'record', props: { of: 'jobs', id: 'j1' } }
			});
			mounted.push(async () => {
				await unmount(app);
				target.remove();
			});
			yield* browser(() => settle());
			assert.equal(answers.length, 1);
			current = { ...LIVE, revision: 4 };
			for (const reader of readers) reader();
			yield* browser(() => settle());
			assert.equal(answers.length, 2);
			required(answers[1])([]);
			yield* browser(() => settle());
			required(answers[0])([approvalView({ id: 'old', status: 'Pending' })]);
			yield* browser(() => settle());
			assert.doesNotMatch(
				textOf(element<HTMLElement>(target, '[data-record-head]')),
				/Pending review/
			);
			assert.equal(target.querySelector('[data-record-pane=approval] .bg-brand'), null);
		})
);
