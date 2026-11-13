import { committed, single_act, type SentAct } from './act-envelope.ts';
import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import {
	viewFixture,
	jsonRecord,
	jsonArray,
	recordRootsOf,
	type ViewScript,
	browser
} from './view-fixture.ts';
import { Deferred, Effect } from 'effect';
import { READ_LIMIT } from '../src/read/request.ts';
// The record shell's header chrome: the history scrubber (a past revision shows read-only, then back to current), the
// record/approval toggle for native proposals, and no per-field history or History tab.
import './dom.ts';
import assert from 'node:assert/strict';
import type { Json } from '@norbital-ai/store';
import type { Value } from '@norbital-ai/store/kind';
import type { ApprovalView, HistoryEntry } from '../src/client/contract.ts';
import type { RecordCapabilities } from '../src/record/types.ts';
import type { Row } from '../src/model/types.ts';
import type { KindsHost } from '../src/kinds/context.ts';
import type { ViewPart } from './view-harness.svelte';
import type { RecordFooterHarnessProps } from './record-footer-harness.svelte';
import type { Outcome as WireOutcome } from '../../bolt/build/protocol/schema.js';
import { it, afterEach } from '@effect/vitest';
import { vi } from 'vitest';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: RecordShell } = await import('../src/record/RecordShell.svelte');
const { default: FooterHarness } = await import('./record-footer-harness.svelte');

const catalog = {
	jobs: {
		record_label: 'record.title',
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
const HISTORY: readonly HistoryEntry[] = [
	{
		revision: 1,
		schema_version: 'schema-1',
		at: '2026-09-01T00:00:00.000Z',
		actor: { kind: 'member', id: 'u1' },
		restored_from: null,
		approval: null,
		changed: { title: 'Paint' },
		cause: 'direct',
		incompatible: [],
		valid: true
	},
	{
		revision: 2,
		schema_version: 'schema-1',
		at: '2026-09-02T00:00:00.000Z',
		actor: { kind: 'system', id: 'run1' },
		restored_from: null,
		approval: null,
		changed: { title: 'Paint v2', updated_at: 'x' },
		cause: 'direct',
		incompatible: [],
		valid: true
	},
	{
		revision: 3,
		schema_version: 'schema-1',
		at: '2026-09-03T00:00:00.000Z',
		actor: { kind: 'member', id: 'u1' },
		restored_from: null,
		approval: null,
		changed: { title: 'Paint v3', crew: 'B' },
		cause: 'direct',
		incompatible: [],
		valid: true
	}
];
const approvalView = (request: Partial<ApprovalView> & { id: string }): ApprovalView => ({
	model: 'jobs',
	record: 'j1',
	action: 'update',
	label: null,
	at: '2026-09-01T00:00:00Z',
	status: 'Pending',
	step: 0,
	steps: [{ name: 'Review', teams: ['reviewers'], users: [] }],
	superseded_by: [],
	team_names: {},
	user_names: {},
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
	requests: readonly (Partial<ApprovalView> & { id: string })[] = [],
	cat: NonNullable<KindsHost['catalog']> = catalog
) {
	const calls: {
		gets: { c: string; id: string; revision?: number; layers?: Readonly<Record<string, Json>> }[];
		history: number;
		historyViews: number[];
		acts: SentAct[];
	} = { gets: [], history: 0, acts: [], historyViews: [] };
	const fixture = await viewFixture({
		// the host's catalogue also exposes the people a record's history names
		catalog: { ...cat, sys_user: { label: ['name'], fields: { name: { kind: 'text' } }, audit: false } },
		get: (c, id, layers, options) => {
			// a past revision is read as of the instant its history entry was written
			const revision = HISTORY.find((entry) => entry.at === options?.as_of)?.revision;
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
		history: (model, id, options) => {
			const at = options?.at;
			if (
				options?.view === true &&
				at !== null &&
				typeof at === 'object' &&
				'revision' in at &&
				typeof at?.revision === 'number'
			) {
				const revision = at.revision;
				calls.historyViews.push(revision);
				const values = PAST[revision];
				return values === undefined
					? null
					: {
							model,
							record: id,
							revision,
							at: HISTORY.find((h) => h.revision === revision)?.at ?? null,
							schema_version: 'schema-1',
							fields: { title: { kind: 'text' }, crew: { kind: 'text', optional: true } },
							values,
							compatible: values,
							incompatible: []
						};
			}
			calls.history++;
			return HISTORY;
		},
		act: (body, key) => {
			calls.acts.push({ ...single_act(body), key });
			return { ...committed(body), records: [{ model: 'jobs', id: 'j1', revision: 4 }] };
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

it.live('the record heading evaluates the shared model CEL label', () =>
	Effect.gen(function* () {
		const { bolt } = yield* browser(() => fake(LIVE));
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog: {
					jobs: {
						...catalog.jobs,
						label: ['title', 'crew'],
						record_label: "record.title + ' · Crew ' + record.crew"
					}
				},
				part: 'record',
				view: RecordShell,
				props: { of: 'jobs', id: 'j1' }
			}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(async () => {
			await settle();
			assert.match(target.textContent ?? '', /Paint v3 · Crew B/);
			assert.equal(
				target.querySelector('[role=dialog]')?.getAttribute('aria-label'),
				'Paint v3 · Crew B'
			);
		});
	})
);
it.live("an authored title names the sheet instead of the record's label", () =>
	Effect.gen(function* () {
		const { bolt } = yield* browser(() => fake(LIVE));
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog,
				part: 'record',
				view: RecordShell,
				props: { of: 'jobs', id: 'j1', title: 'Custom' }
			}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(async () => {
			await settle();
			assert.equal(target.querySelector('[role=dialog]')?.getAttribute('aria-label'), 'Custom');
		});
	})
);
it.live('the record heading uses its id when no label is declared', () =>
	browser(async () => {
		const { target } = await show(LIVE, {
			jobs: { ...catalog.jobs, record_label: undefined, label: [] }
		});
		assert.match(target.textContent ?? '', /j1/);
	})
);
afterEach(async () => {
	localStorage.clear();
	for (const close of mounted.splice(0).reverse()) await close();
});
async function show(
	live: Value,
	shownCatalog: NonNullable<KindsHost['catalog']> = catalog,
	act?: ViewScript['act'],
	capabilities?: NonNullable<ViewScript['capabilities']>,
	requests: readonly (Partial<ApprovalView> & { id: string })[] = [],
	history?: ViewScript['history']
) {
	const { bolt, script, setCapabilities, calls } = await fake(live, requests, shownCatalog);
	if (act !== undefined) script.act = act;
	if (history !== undefined) script.history = history;
	if (capabilities !== undefined) setCapabilities(capabilities);
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, {
		target,
		props: {
			bolt,
			catalog: shownCatalog,
			part: 'record',
			view: RecordShell,
			props: { of: 'jobs', id: 'j1' }
		}
	});
	await settle();
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	return {
		target,
		calls,
		history: () =>
			document.querySelector<HTMLElement>('[data-record-timeline] [data-record-history-events]'),
		openHistory: async () => {
			element<HTMLElement>(target, 'header [data-timeline-trigger]').click();
			await settle();
		}
	};
}
const pickHistory = async (revision: number) => {
	element<HTMLElement>(
		document,
		`[data-record-timeline] [data-history-pick="${revision}"]`
	).click();
	await settle();
};
const backToCurrent = async () => {
	element<HTMLElement>(document, '[data-record-timeline] [data-record-history-current]').click();
	await settle();
};
const edit = (t: ParentNode) =>
	[...t.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b).trim() === 'Edit');

it.live('history renders old field labels and values with an incompatible indicator', () =>
	Effect.gen(function* () {
		const v = yield* browser(() =>
			show(LIVE, catalog, undefined, undefined, [], (_model, _id, options) =>
				options?.view === true
					? {
							model: 'jobs',
							record: 'j1',
							revision: 2,
							at: HISTORY[1]?.at ?? null,
							schema_version: 'old-schema',
							fields: {
								old_title: { kind: 'text', label: 'Original title' },
								retired: { kind: 'text', label: 'Retired field' }
							},
							values: { old_title: 'Old paint', retired: 'Original value' },
							compatible: { title: 'Old paint' },
							incompatible: ['retired']
						}
					: HISTORY.map((entry) =>
							entry.revision === 2 ? { ...entry, incompatible: ['retired'], valid: false } : entry
						)
			)
		);
		yield* browser(() => v.openHistory());
		assert.match(
			textOf(element<HTMLElement>(document, '[data-history-revision="2"]')),
			/Not valid/
		);
		assert.match(textOf(element<HTMLElement>(document, '[data-history-revision="1"]')), /Valid/);
		yield* browser(() => pickHistory(2));
		const old = element<HTMLElement>(v.target, '[data-history-field=old_title]');
		assert.match(textOf(old), /Original title/);
		assert.match(textOf(old), /Old paint/);
		const retired = element<HTMLElement>(v.target, '[data-history-field=retired]');
		assert.match(textOf(retired), /Original value/);
		assert.equal(
			textOf(element<HTMLElement>(retired, '[data-history-incompatible]')).trim(),
			'incompatible'
		);
		assert.equal(v.target.querySelector('[data-field=title]'), null);
	})
);

it.live(
	'history loads lazily; a past revision shows read-only, then the current entry returns to the live, editable record',
	() =>
		Effect.gen(function* () {
			const v = yield* browser(() => show(LIVE));
			assert.ok(
				edit(element<HTMLElement>(v.target, '[data-record-foot]')),
				'Edit is in the footer'
			);
			assert.equal(edit(element<HTMLElement>(v.target, '[data-record-head]')), undefined);
			assert.equal(v.history(), null, 'the timeline is hidden until opened');
			assert.equal(v.calls.history, 0, 'history loads lazily');
			yield* browser(() => v.openHistory());
			assert.ok(
				element<HTMLElement>(document, '[data-record-timeline] [data-record-history-events]')
			);
			assert.match(
				textOf(element<HTMLElement>(document, '[data-history-revision="3"]')),
				/\(in 8 months\)/
			);
			yield* browser(() => pickHistory(2));
			assert.ok(v.calls.historyViews.includes(2), 'read exact revision 2 with its original schema');
			assert.ok(element<HTMLElement>(v.target, '[data-record-past]'));
			assert.doesNotMatch(
				textOf(element<HTMLElement>(v.target, '[data-record-past]')),
				/2026-09-02T/,
				'historical notice uses a formatted time, not raw ISO'
			);
			assert.ok(element<HTMLElement>(v.target, 'fieldset[disabled]'));
			assert.match(textOf(element<HTMLElement>(v.target, '[data-field=title]')), /Paint v2/);
			assert.equal(edit(v.target), undefined, 'no Edit on a past revision');
			yield* browser(backToCurrent);
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
				skipped: [{ field: 'crew', reason: 'no_grant', current: 'B', restored: null }]
			});
			const v = yield* browser(() =>
				show(LIVE, catalog, (body) => {
					const { callable, input, observed } = single_act(body);
					acts.push({ callable, input, ...(observed === undefined ? {} : { observed }) });
					const asked = jsonRecord(input)['revision'];
					return callable === 'history.preview'
						? { kind: 'committed', output: preview(Number(asked)), records: [] }
						: { ...committed(body), records: [{ model: 'jobs', id: 'j1', revision: 4 }] };
				})
			);
			yield* browser(() => v.openHistory());
			yield* browser(() => pickHistory(2));
			assert.ok(
				!acts.some((a) => a.callable === 'history.preview'),
				'scrubbing alone reads no preview'
			);
			element<HTMLButtonElement>(v.target, '[data-record-past] [data-record-restore]').click();
			yield* browser(settle);
			const dialog = element<HTMLElement>(document, '[data-restore-preview="2"]');
			assert.match(textOf(element(dialog, '[data-restore-field=title]')), /Paint v3.*Paint v2/);
			const skipped = element<HTMLElement>(dialog, '[data-restore-skip=crew]');
			assert.equal(skipped.getAttribute('data-reason'), 'no_grant');
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
			yield* browser(() => pickHistory(1));
			element<HTMLButtonElement>(v.target, '[data-record-past] [data-record-restore]').click();
			yield* browser(settle);
			const empty = element<HTMLElement>(document, '[data-restore-preview]');
			assert.ok(element(empty, '[data-restore-nothing]'));
			assert.equal(empty.querySelector('[data-restore-confirm]'), null);
		})
);

// A record's fields are the author's: an omitted field or relation stays out of the read view and the edit form.
const deals = {
	deals: {
		record_label: 'record.title',
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
	clients: { record_label: 'record.name', label: ['name'], fields: { name: { kind: 'text' } } }
} satisfies NonNullable<KindsHost['catalog']>;
const DEAL = { id: 'd1', revision: 1, title: 'Build', kind: 'sow', channel: 'mail', client: 'c1' };
async function mountDeal(fixture: Extract<ViewPart, { part: 'record' }>) {
	const { bolt, script, calls } = await fake(DEAL, [], deals);
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

it.live('authored record fields restrict read relations and the subsequent edit form', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() =>
			mountDeal({
				part: 'record',
				view: RecordShell,
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
	'a live state transition locks an open form without discarding its permitted unsaved draft',
	() =>
		Effect.gen(function* () {
			let current = { id: 'j1', revision: 1, title: 'Agreement', crew: 'A', status: 'draft' };
			const readers = new Set<() => void>();
			const rules: NonNullable<KindsHost['catalog']> = {
				jobs: {
					...catalog.jobs,
					locks: [{ where: { status: { eq: 'confirmed' } }, except: ['crew', 'status'] }, { where: { status: { eq: 'closed' } } }],
					fields: {
						...catalog.jobs.fields,
						status: {
							kind: 'state',
							initial: 'draft',
							states: {
								draft: { to: ['confirmed'] },
								confirmed: { to: ['closed'] },
								closed: {}
							}
						}
					}
				}
			};
			const { bolt, script, setCapabilities } = yield* browser(() => fake(current, [], rules));
			const originalLiveGet = script.get;
			script.get = (c, id, select, options) =>
				c === 'jobs' && options?.as_of === undefined
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
				props: {
					bolt,
					catalog: rules,
					part: 'record',
					view: RecordShell,
					props: { of: 'jobs', id: 'j1' }
				}
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

it.live('native history merges scoped related records and keeps its scrubber', () =>
	Effect.gen(function* () {
		const related: NonNullable<KindsHost['catalog']> = {
			...catalog,
			activities: { record_label: 'record.title', label: ['title'], fields: { title: { kind: 'text' } } }
		};
		const { bolt, script, setCapabilities, calls } = yield* browser(() => fake(LIVE, [], related));
		let query: import('./view-fixture.ts').ReadOptions | undefined;
		script.read = (c, o) => {
			query = o;
			return { rows: [{ id: 'a1', title: 'Customer call' }], next: null };
		};
		script.history = (c, id) =>
			c === 'jobs'
				? HISTORY
				: ([
						{
							revision: 2,
							schema_version: 'schema-1',
							at: '2026-09-04T00:00:00.000Z',
							actor: { kind: 'member', id: 'u1' },
							restored_from: null,
							approval: null,
							changed: { title: 'Customer call' },
							cause: 'direct',
							incompatible: [],
							valid: true
						},
						// a related save that changed no visible field is not a timeline event
						{
							revision: 3,
							schema_version: 'schema-1',
							at: '2026-09-05T00:00:00.000Z',
							actor: { kind: 'member', id: 'u1' },
							restored_from: null,
							approval: null,
							changed: {},
							cause: 'direct',
							incompatible: [],
							valid: true
						}
					] satisfies readonly HistoryEntry[]);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog: related,
				part: 'record',
				view: RecordShell,
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
		assert.deepEqual(query, { where: { job: { eq: 'j1' } }, limit: READ_LIMIT, fields: ['title'] });
		const events = element<HTMLElement>(document, '[data-record-history-events]');
		assert.match(textOf(events), /Customer call/);
		assert.match(textOf(events), /Ada/);
		const relatedEvents = events.querySelectorAll<HTMLElement>('[data-history-model="activities"]');
		assert.equal(relatedEvents.length, 1, 'a related no-op save stays out of the timeline');
		const [firstEvent, secondEvent] = events.querySelectorAll<HTMLElement>('[data-history-model]');
		assert.equal(required(firstEvent).dataset.historyModel, 'jobs');
		assert.equal(required(secondEvent).dataset.historyModel, 'activities');
		assert.ok(element<HTMLElement>(document, '[data-record-timeline] [data-history-pick]'));
	})
);

it.live(
	'save carries the loaded draft revision, Cancel refuses to discard an unsaved edit silently, and a source-managed field keeps its value',
	() =>
		Effect.gen(function* () {
			const v = yield* browser(() =>
				show(LIVE, { jobs: { ...catalog.jobs, readonly_fields: { crew: 'sync_owned' } } })
			);
			required(edit(v.target)).click();
			yield* browser(() => settle());
			const crew = element<HTMLElement>(v.target, '[data-field=crew]');
			assert.match(textOf(crew), /B/);
			assert.ok(element<HTMLElement>(crew, '[data-field-restriction]'));
			assert.equal(crew.querySelector('input'), null);
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
			assert.deepEqual(jsonRecord(required(jsonArray(required(v.calls.acts[0]).input)[0])).target, { id: 'j1', revision: 3 });
			assert.deepEqual(required(v.calls.acts[0]).input, [
				{ target: { id: 'j1', revision: 3 }, set: { title: 'A changed title' } }
			]);
		})
);

it.live('an edit survives closing its record: it reopens as a draft, and Cancel discards it', () =>
	Effect.gen(function* () {
		const first = yield* browser(() => show(LIVE, catalog));
		required(edit(first.target)).click();
		yield* browser(() => settle());
		const input = element<HTMLInputElement>(first.target, '[data-field=title] input');
		input.value = 'A changed title';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		yield* browser(() => settle());
		yield* browser(() => required(mounted.pop())());
		const again = yield* browser(() => show(LIVE, catalog));
		yield* browser(() => settle());
		assert.equal(
			element<HTMLInputElement>(again.target, '[data-field=title] input').value,
			'A changed title'
		);
		assert.deepEqual(again.calls.acts, []);
		required(
			[...again.target.querySelectorAll<HTMLButtonElement>('button')].find(
				(b) => textOf(b).trim() === 'Cancel'
			)
		).click();
		yield* browser(async () => {
			await vi.waitFor(() =>
				assert.ok(document.querySelector('[data-confirm-dialog][data-state=open]'))
			);
			element<HTMLButtonElement>(document, '[data-confirm-accept]').click();
			await settle();
		});
		assert.equal(localStorage.length, 0);
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
		const save = [...target.querySelectorAll<HTMLButtonElement>('[data-record-foot] button')].find(
			(b) => textOf(b).trim() === 'Save'
		);
		assert.ok(save);
		save.click();
		yield* browser(() => settle());
		assert.equal(calls.acts.length, 1);
		assert.deepEqual(required(calls.acts[0]).input, [
			{ target: { id: 'j1', revision: 3 }, set: { title: 'Shared title', crew: 'Shared crew' } }
		]);
		assert.deepEqual(jsonRecord(required(jsonArray(required(calls.acts[0]).input)[0])).target, { id: 'j1', revision: 3 });
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
				c === 'jobs' && options?.as_of === undefined
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
				props: { bolt, catalog, part: 'record', view: RecordShell, props: { of: 'jobs', id: 'j1' } }
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
			yield* browser(() => pickHistory(2));
			assert.match(textOf(element<HTMLElement>(target, '[data-field=title]')), /Paint v2/);
			current = { ...LIVE, revision: 4, title: 'Concurrent title' };
			for (const reader of readers) reader();
			yield* browser(() => settle());
			yield* browser(backToCurrent);
			assert.equal(
				element<HTMLInputElement>(target, '[data-field=title] input').value,
				'Unsaved draft'
			);
			element<HTMLFormElement>(target, 'form').dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true })
			);
			yield* browser(() => settle());
			assert.deepEqual(
				jsonRecord(required(jsonArray(required(calls.acts.find((a) => a.callable === 'jobs.update')).input)[0])).target,
				{ id: 'j1', revision: 3 }
			);
		})
);

const nativeCapabilities: RecordCapabilities = {
	model: 'jobs',
	id: 'j1',
	revision: 3,
	fields: {
		title: { writable: true, proposal: false, reasons: [] },
		crew: { writable: false, proposal: false, reasons: ['state_locked'] }
	},
	update: { allowed: true, proposal: false, reasons: [] },
	delete: { allowed: false, proposal: false, reasons: ['no_grant'] },
	moves: {},
	proposal_moves: {}
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
			textOf(element<HTMLElement>(crew, '[data-field-restriction=state_locked]')),
			/current state/
		);
	})
);

it.live(
	'a proposal field requests approval beside a direct field while locked fields remain readable',
	() =>
		Effect.gen(function* () {
			const proposal: RecordCapabilities = {
				...nativeCapabilities,
				fields: {
					title: { writable: false, proposal: true, reasons: ['no_grant'] },
					crew: { writable: false, proposal: false, reasons: ['sync_owned'] },
					note: { writable: true, proposal: false, reasons: [] }
				},
				update: { allowed: true, proposal: true, reasons: [] },
				proposal_moves: {}
			};
			const v = yield* browser(() =>
				show(
					LIVE,
					catalog,
					(body, key) => {
						v.calls.acts.push({ ...single_act(body), key });
						return { kind: 'pending_approval', request_id: 'approval1', records: [] };
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
			assert.deepEqual(jsonRecord(required(jsonArray(required(v.calls.acts[0]).input)[0])).target, { id: 'j1', revision: 3 });
			assert.deepEqual(required(v.calls.acts[0]).input, [
				{ target: { id: 'j1', revision: 3 }, set: { title: 'Proposed title' } }
			]);
			assert.equal(v.target.querySelector('[data-field=title] input'), null);
			assert.match(textOf(element<HTMLElement>(v.target, '[data-field=title]')), /Paint v3/);
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
				c === 'jobs' && options?.as_of === undefined
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
				props: { bolt, catalog, part: 'record', view: RecordShell, props: { of: 'jobs', id: 'j1' } }
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
		script.act = (body) => {
			acts.push(single_act(body).callable);
			return {
				kind: 'pending_approval',
				request_id: 'r1',
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
				view: RecordShell,
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

const nativeFooter = (target: ParentNode) => {
	assert.equal(target.querySelectorAll('[data-record-foot]').length, 1, 'one native footer');
	const footer = element<HTMLElement>(target, '[data-record-foot]');
	assert.equal(footer.closest('[data-record-main]'), null, 'footer is outside scrolling content');
	return footer;
};
async function showFooter(
	fixture: Awaited<ReturnType<typeof fake>>,
	props: Partial<Omit<RecordFooterHarnessProps, 'bolt'>> = {}
) {
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(FooterHarness, { target, props: { bolt: fixture.bolt, catalog, ...props } });
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await settle();
	return target;
}
const represented = async (target: ParentNode) => {
	await vi.waitFor(() => assert.ok(target.querySelector('[data-long-detail]')));
	await settle();
};

it.live('loading, readonly, missing and failed records retain one native footer', () =>
	browser(async () => {
		const waiting = await fake(null);
		const gate = Promise.withResolvers<Value>();
		waiting.script.get = () => gate.promise;
		const loading = await showFooter(waiting, { representation: 'generated' });
		const foot = nativeFooter(loading);
		assert.ok(loading.querySelector('[data-read=loading]'));
		gate.resolve(LIVE);
		await settle();
		assert.equal(nativeFooter(loading), foot, 'settling the read keeps the native frame');

		const readonly = await showFooter(await fake(LIVE), {
			representation: 'generated', catalog: { jobs: { label: catalog.jobs.label, fields: catalog.jobs.fields } }
		});
		nativeFooter(readonly);
		assert.equal(edit(readonly), undefined);
		assert.equal(readonly.querySelector('[data-form-footer]'), null);

		const missing = await showFooter(await fake(null), { representation: 'generated' });
		nativeFooter(missing);
		assert.ok(missing.querySelector('[data-read=not_found]'));

		const failed = await fake(null);
		failed.script.get = () => Response.json({ error: { code: 'internal', message: 'Read unavailable' } }, { status: 500 });
		const error = await showFooter(failed, { representation: 'generated' });
		await vi.waitFor(() => assert.ok(error.querySelector('[data-read=error]')));
		nativeFooter(error);
		assert.equal(edit(error), undefined);
	})
);

it.live('raw and decorated registered representations share one native frame and footer across tabs', () =>
	browser(async () => {
		for (const representation of ['raw', 'decorated'] as const) {
			let actions = 0;
			const target = await showFooter(await fake(LIVE), { representation, on_native_action: () => actions++ });
			await represented(target);
			const foot = nativeFooter(target);
			assert.equal(target.querySelectorAll('[data-view=record]').length, 1);
			assert.equal(target.querySelectorAll('[data-record-head]').length, 1);
			if (representation === 'decorated') {
				assert.equal(element<HTMLElement>(target, '[role=dialog]').getAttribute('aria-label'), 'Authored job');
				assert.match(textOf(foot), /Authored footer/);
				element<HTMLButtonElement>(foot, '[data-native-action]').click();
				assert.equal(actions, 1);
				const tabs = [...target.querySelectorAll<HTMLButtonElement>('[role=tab]')];
				required(tabs.find((tab) => textOf(tab).trim() === 'Extra detail')).click();
				await settle();
				assert.ok(target.querySelector('[data-extra-detail]'));
				assert.equal(nativeFooter(target), foot);
				assert.ok(edit(foot), 'record edit remains available on an authored tab');
				required(tabs.find((tab) => textOf(tab).trim() === 'Record')).click();
				await settle();
			}
		}
	})
);

it.live('registered historical content and footer actions are readonly while approval decisions stay enabled', () =>
	browser(async () => {
		let actions = 0;
		const fixture = await fake(LIVE, [{ id: 'footer-approval', moves: [{ decision: 'approve', reason: 'optional' }] }]);
		const target = await showFooter(fixture, { on_native_action: () => actions++ });
		await represented(target);
		element<HTMLButtonElement>(target, '[data-native-action]').click();
		assert.equal(actions, 1);
		element<HTMLButtonElement>(target, 'header [data-timeline-trigger]').click();
		await settle();
		await pickHistory(2);
		await represented(target);
		nativeFooter(target);
		assert.match(textOf(element<HTMLElement>(target, '[data-field=title]')), /Paint v2/);
		assert.equal(edit(target), undefined);
		// the DOM fixture does not apply a disabled fieldset to its controls; a browser disables (and stops clicks on) them
		const disabled = (button: HTMLButtonElement) => button.matches(':disabled') || button.closest('fieldset[disabled]') !== null;
		const action = element<HTMLButtonElement>(target, '[data-native-action]');
		assert.equal(disabled(action), true);

		element<HTMLButtonElement>(target, '[data-record-pane=approval]').click();
		await settle();
		nativeFooter(target);
		const approve = element<HTMLButtonElement>(target, 'button[data-decision=approve]');
		assert.equal(disabled(approve), false);
		approve.click();
		await settle();
		assert.ok(target.querySelector('form[data-decision=approve]'), 'approval decision can advance while viewing history');
		element<HTMLButtonElement>(target, '[data-record-pane=record]').click();
		await settle();
		element<HTMLButtonElement>(target, '[data-record-back]').click();
		await settle();
		await represented(target);
		const current = element<HTMLButtonElement>(nativeFooter(target), '[data-native-action]');
		assert.equal(disabled(current), false);
		current.click();
		assert.equal(actions, 2);
	})
);

it.live('a custom create keeps one native submit label and preserves local and independent form ownership', () =>
	browser(async () => {
		const fixture = await fake(null);
		const target = await showFooter(fixture, {
			mode: 'create', form_actions: true, independent_form: true, on_done: () => {},
			catalog: {
				jobs: { ...catalog.jobs, create: { columns: ['title', 'crew'] } },
				notes: { label: ['title'], fields: { title: { kind: 'text' } }, create: { columns: ['title'] } }
			}
		});
		await represented(target);
		const foot = nativeFooter(target);
		assert.equal([...target.querySelectorAll('button')].filter((button) => textOf(button).trim() === 'Create named job').length, 1);
		assert.match(textOf(foot), /Create named job/);
		const local = element<HTMLButtonElement>(target, '[data-form-action]');
		const matching = element<HTMLFormElement>(target, '[data-long-detail] form');
		assert.equal(local.form, matching, 'authored submit remains associated with its original form');
		const independent = [...target.querySelectorAll<HTMLButtonElement>('button')].find((button) => textOf(button).trim() === 'Create independent note');
		assert.ok(independent);
		assert.ok(independent.form);
		assert.notEqual(independent.form, matching);
		assert.equal(foot.contains(independent), false);
		const title = element<HTMLInputElement>(matching, '[data-field=title] input');
		title.value = 'Named job';
		title.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		element<HTMLButtonElement>(foot, '[data-record-save]').click();
		await settle();
		assert.equal(fixture.calls.acts.length, 1);
		assert.equal(required(fixture.calls.acts[0]).callable, 'jobs.create');
		assert.deepEqual(required(fixture.calls.acts[0]).input, [{ title: 'Named job' }]);
	})
);

it.live('a record its rejected create removed keeps its label, its outcome and no approval badge', () =>
	browser(async () => {
		const { target } = await show(null, catalog, undefined, undefined, [
			{
				id: 'gone',
				action: 'create',
				status: 'Rejected',
				label: 'Duplicate buyer',
				records: [{ model: 'jobs', id: 'j1', op: 'create' }],
				log: [
					{ move: 'request', by: { ref: 'member:ada', name: 'Ada' }, at: '2026-09-01T00:00:00Z', from: null, to: 'Pending', step: 0, reason: null },
					{ move: 'reject', by: { ref: 'member:sam', name: 'Sam' }, at: '2026-09-02T00:00:00Z', from: 'Pending', to: 'Rejected', step: 0, reason: 'Already on file' }
				]
			}
		]);
		assert.match(textOf(element<HTMLElement>(target, '[data-record-head] h2')), /Duplicate buyer/);
		assert.equal(target.querySelector('[data-view=approval-badge]'), null);
		assert.match(textOf(element<HTMLElement>(target, '[data-view=approval-outcome]')), /Rejected · Sam/);
		assert.match(textOf(element<HTMLElement>(target, '[data-view=approval-history]')), /Already on file/);
	})
);
it.live('the approval badge says "Changes requested" in words and follows the live row, not stale capabilities', () =>
	browser(async () => {
		const asked = await show(LIVE, catalog, undefined, undefined, [{ id: 'asked', status: 'ChangesRequested' }]);
		assert.equal(textOf(element<HTMLElement>(asked.target, '[data-view=approval-badge]')).trim(), 'Changes requested');
		// a withdrawn request's record: its capabilities were read while it was held, its row carries no `$approval`
		const withdrawn = await show(
			LIVE,
			catalog,
			undefined,
			async () => ({
				...nativeCapabilities,
				update: { allowed: false, proposal: false, reasons: ['under_approval'] }
			}),
			[{ id: 'withdrawn', status: 'Withdrawn' }]
		);
		assert.equal(withdrawn.target.querySelector('[data-view=approval-badge]'), null);
	})
);
it.live('blank text reads as the one empty "—"', () =>
	browser(async () => {
		const { target } = await show({ ...LIVE, crew: '  ' });
		assert.equal(textOf(element<HTMLElement>(target, '[data-field=crew]')).replace('Crew', '').trim(), '—');
	})
);

it.live('a failed decision keeps the approval pane, its error and its form while the requests reload', () =>
	browser(async () => {
		const busy = 'This workspace is busy. Please try again shortly.';
		const fixture = await fake(LIVE, [{ id: 'busy', moves: [{ decision: 'reject', reason: 'required' }] }]);
		const answered = fixture.script.approval;
		let hang = false;
		// the reload after the decision waits on a host that is still busy
		fixture.script.approval = (params) => (hang ? new Promise(() => {}) : (answered?.(params) ?? []));
		fixture.script.act = () => ({ kind: 'refused', code: 'rate_limited', message: busy });
		const target = await showFooter(fixture, { representation: 'generated' });
		element<HTMLButtonElement>(target, '[data-record-pane=approval]').click();
		await settle();
		element<HTMLButtonElement>(target, 'button[data-decision=reject]').click();
		await settle();
		const reason = element<HTMLTextAreaElement>(target, '[data-view=approval-controls] textarea');
		reason.value = 'Too costly';
		reason.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		hang = true;
		element<HTMLButtonElement>(target, '[data-confirm]').click();
		await settle();
		assert.equal(textOf(element<HTMLElement>(target, '[data-view=approval-notice][role=alert]')).trim(), busy);
		assert.ok(target.querySelector('form[data-decision=reject]'), 'the request stays decidable');
		assert.ok(target.querySelector('[data-view=approval-badge]'));
	})
);

it.live('Withdraw clears the header badge at once, in a represented record too, though the row still carries `$approval`', () =>
	browser(async () => {
		let status: ApprovalView['status'] = 'Pending';
		const fixture = await fake({
			...LIVE,
			$approval: { request_id: 'mine', state: 'Pending', step: 0, steps: [{ name: 'Review', teams: ['reviewers'], users: [] }], requested_by: 'Ada' }
		});
		fixture.script.approval = () => [
			approvalView({ id: 'mine', status, mine: true, moves: status === 'Pending' ? [{ decision: 'withdraw', reason: 'optional' }] : [] })
		];
		fixture.script.act = (body) => {
			status = 'Withdrawn';
			return committed(body);
		};
		const target = await showFooter(fixture);
		await represented(target);
		assert.ok(target.querySelector('[data-view=approval-badge]'));
		element<HTMLButtonElement>(target, '[data-record-pane=approval]').click();
		await settle();
		assert.ok(target.querySelector('[data-view=approval-badge]'), 'the badge stays while the pane is open');
		element<HTMLButtonElement>(target, 'button[data-decision=withdraw]').click();
		await settle();
		element<HTMLButtonElement>(target, '[data-confirm]').click();
		// a boolean: a failing assert would format the whole DOM node on every poll
		await vi.waitFor(() => assert.ok(target.querySelector('[data-view=approval-badge]') === null, 'the badge is gone'));
	})
);

it.live('record history lists a request for changes and says where a request stands in plain words', () =>
	Effect.gen(function* () {
		const v = yield* browser(() =>
			show(
				LIVE,
				catalog,
				undefined,
				undefined,
				[
					{
						id: 'asked',
						status: 'ChangesRequested',
						log: [
							{ move: 'request', by: { ref: 'member:ada', name: 'Ada' }, at: '2026-09-03T00:00:00Z', from: null, to: 'Pending', step: 0, reason: null },
							{ move: 'request_changes', by: { ref: 'member:sam', name: 'Sam' }, at: '2026-09-04T00:00:00Z', from: 'Pending', to: 'ChangesRequested', step: 0, reason: 'Add the quote' }
						]
					}
				],
				() =>
					HISTORY.map((entry) =>
						entry.revision === 3 ? { ...entry, approval: { request: 'asked', state: 'Pending' } } : entry
					)
			)
		);
		yield* browser(() => v.openHistory());
		const events = required(v.history());
		assert.match(textOf(element<HTMLElement>(events, '[data-history-revision="3"]')), /Waiting for approval/);
		assert.doesNotMatch(textOf(events), /approval Pending/);
		const asked = element<HTMLElement>(events, '[data-history-decision]');
		assert.match(textOf(asked), /Requested changes · Sam.*“Add the quote”/s);
	})
);
