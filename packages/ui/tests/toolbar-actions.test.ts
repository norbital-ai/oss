import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import { viewFixture, jsonRecord, type ViewScript, browser } from './view-fixture.ts';
import { Deferred, Effect, Queue, Schema, Stream } from 'effect';
// The toolbar's ⚡ menu: an author item is an icon, a name, a description and its handler; the menu keeps each row's
// state (pending, done, failed in place and as a toast) and wires a model's file sync in by itself.
import './dom.ts';
import assert from 'node:assert/strict';
import type { Value } from '@norbital-ai/std/kind';
import { Decimal } from '@norbital-ai/std/decimal';
import type { KindsHost } from '../src/kinds/context.ts';
import type { ViewBolt, Outcome, RunRow } from '../src/client/contract.ts';
import type { Page } from '../src/model/types.ts';
import type { TableSource, TableProps } from '../src/table/Table.svelte';
import type { Toolbar, ToolbarItem } from '../src/model/ViewToolbar.svelte';
import { ActRefused } from '../../bolt/build/decl/errors.js';
import { runningFibers } from '../src/effect/index.ts';
import { it, afterEach } from '@effect/vitest';
import { vi } from 'vitest';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Table } = await import('../src/table/Table.svelte');
const { toasts } = await import('../src/toast/toast.svelte.ts');

const mounted: (() => Promise<void>)[] = [];
const settle = async () => {
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
	flushSync();
};
afterEach(async () => {
	for (const close of mounted.splice(0).reverse()) await close();
	document.body.replaceChildren();
	toasts.splice(0);
});

async function fakeBolt(extra: Partial<ViewScript> = {}) {
	const started: { automation: string; input: Value }[] = [];
	let serial = 0;
	const fixture = await viewFixture({
		aggregate: () => ({ count: 0 }),
		start: (automation, input) => {
			started.push({ automation, input });
		},
		uuid: () => `run-${++serial}`,
		...extra
	});
	return { ...fixture, started };
}
async function show({
	actions,
	catalog = {},
	of = [{ id: 'a', name: 'Ada' }],
	upload,
	bolt: provided,
	context,
	columns = ['name'],
	csv = false
}: {
	actions?: readonly ToolbarItem[];
	catalog?: NonNullable<KindsHost['catalog']>;
	of?: TableSource;
	upload?: KindsHost['upload'];
	bolt?: ViewBolt;
	context?: Exclude<Toolbar, false>['context'];
	columns?: TableProps<TableSource>['columns'];
	csv?: boolean;
}) {
	const bolt = provided ?? (await fakeBolt()).bolt;
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, {
		target,
		props: {
			bolt,
			catalog,
			...(upload === undefined ? {} : { upload }),
			part: 'table',
			view: Table,
			props: {
				of,
				columns,
				toolbar: {
					title: false,
					search: false,
					filter: false,
					export: csv,
					new: false,
					...(actions === undefined ? {} : { actions }),
					...(context === undefined ? {} : { context })
				}
			}
		}
	});
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await settle();
	return target;
}
const open = async () => {
	if (document.querySelector('[data-view-menu]') !== null) return;
	element<HTMLButtonElement>(document, '[data-view-actions]').click();
	await settle();
};
const row = (key: string) =>
	element<HTMLElement>(document, `[data-view-menu] [data-menu-item="${key}"]`);
const press = async (key: string) => {
	element<HTMLButtonElement>(row(key), 'button').click();
	await settle();
};

it.live(
	'CSV exports retain value rows without IDs, order, quoting and model reference labels',
	() =>
		Effect.gen(function* () {
			const blobs: Blob[] = [];
			const objectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
				assert.ok(blob instanceof Blob);
				blobs.push(blob);
				return 'blob:toolbar-csv';
			});
			const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
			const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
			try {
				yield* browser(() =>
					show({
						of: [
							{
								name: '中文, "二"',
								count: 2,
								amount: Decimal.of('9007199254740993.12'),
								quantity: Decimal.of('2.5'),
								currency: 'SGD'
							},
							{
								name: 'Ada',
								count: 1,
								amount: Decimal.of('17'),
								quantity: Decimal.of('1'),
								currency: 'JPY'
							}
						],
						columns: [
							'name',
							'count',
							{ field: 'amount', kind: { kind: 'money', currency: 'currency' } },
							{ field: 'quantity', kind: { kind: 'decimal', scale: 3 } }
						],
						csv: true
					})
				);
				yield* browser(open);
				yield* browser(() => press('export'));
				assert.equal(blobs.length, 1);
				assert.equal(
					yield* browser(() => required(blobs[0]).text()),
					'\uFEFFName,Count,Amount,Quantity\r\n"中文, ""二""",2,9007199254740993.12,2.500\r\nAda,1,17,1.000'
				);
				const close = mounted.pop();
				assert.ok(close);
				yield* browser(close);
				const { bolt } = yield* browser(() =>
					fakeBolt({
						read: () => ({
							rows: [{ id: 'j1', name: 'Record', account: { id: 'a1', name: 'Acme' } }],
							next: null
						})
					})
				);
				yield* browser(() =>
					show({
						bolt,
						of: 'jobs',
						columns: ['name', 'account'],
						csv: true,
						catalog: {
							jobs: {
								label: ['name'],
								fields: { name: { kind: 'text' }, account: { kind: 'id', of: 'accounts' } },
								relations: { account: { targets: ['accounts'] } }
							},
							accounts: { label: ['name'], fields: { name: { kind: 'text' } } }
						}
					})
				);
				yield* browser(open);
				yield* browser(() => press('export'));
				assert.equal(blobs.length, 2);
				assert.equal(
					yield* browser(() => required(blobs[1]).text()),
					'\uFEFFName,Account\r\nRecord,Acme'
				);
			} finally {
				click.mockRestore();
				revoke.mockRestore();
				objectURL.mockRestore();
			}
		})
);

it.live(
	"handler rows: pending spins and disables, a failure is in place and toasted and runs again, a refusal is the row's error, nothing closes the menu",
	() =>
		Effect.gen(function* () {
			const d = yield* Deferred.make<void>();
			let calls = 0,
				fail = true,
				opened = false;
			yield* browser(() =>
				show({
					actions: [
						{
							icon: 'lucide:check',
							name: 'Settle',
							run: () =>
								Effect.suspend(() => {
									calls++;
									return Deferred.await(d);
								})
						},
						{
							icon: 'lucide:check',
							name: 'Pay',
							run: () =>
								Effect.suspend(() =>
									fail ? Effect.fail(new Error('Ledger is locked')) : Effect.succeed(undefined)
								)
						},
						{
							icon: 'lucide:check',
							name: 'Hold',
							run: () => Effect.succeed({ kind: 'committed', output: null, records: [] })
						},
						{
							icon: 'lucide:x',
							name: 'Release',
							run: () => Effect.fail(new ActRefused({ code: 'refused', message: 'Already paid' }))
						},
						{
							icon: 'lucide:x',
							name: 'Waive',
							run: () => {
								opened = true;
							}
						}
					]
				})
			);
			yield* browser(open);
			yield* browser(() => press('item:Settle'));
			assert.equal(row('item:Settle').dataset.status, 'pending');
			assert.equal(element<HTMLButtonElement>(row('item:Settle'), 'button').disabled, true);
			assert.equal(
				element<HTMLButtonElement>(document, '[data-view-actions]').getAttribute('aria-busy'),
				'true'
			);
			yield* Deferred.succeed(d, undefined);
			yield* browser(settle);
			assert.equal(row('item:Settle').dataset.status, 'done');
			assert.equal(calls, 1);

			yield* browser(() => press('item:Pay'));
			assert.equal(row('item:Pay').dataset.status, 'failed');
			assert.equal(
				textOf(element<HTMLElement>(row('item:Pay'), '[data-menu-error]')),
				'Ledger is locked'
			);
			assert.deepEqual(
				toasts.map((t) => [t.tone, t.text]),
				[['error', 'Ledger is locked']]
			);
			fail = false;
			yield* browser(() => press('item:Pay'));
			assert.equal(row('item:Pay').dataset.status, 'done');
			assert.equal(row('item:Pay').querySelector('[data-menu-error]'), null);

			toasts.splice(0);
			yield* browser(() => press('item:Hold'));
			yield* browser(() => press('item:Release'));
			assert.equal(row('item:Hold').dataset.status, 'done');
			assert.equal(row('item:Release').dataset.status, 'failed');
			assert.equal(
				textOf(element<HTMLElement>(row('item:Release'), '[data-menu-error]')),
				'Already paid'
			);
			assert.deepEqual(
				toasts.map((t) => t.tone),
				['success', 'error']
			);

			yield* browser(() => press('item:Waive'));
			assert.equal(opened, true);
			assert.equal(document.querySelector('[data-view-menu]'), null);
		})
);

it.live(
	'a handler returning a run handle shows the run and closes the menu; sync starts the declared model sync by name',
	() =>
		Effect.gen(function* () {
			const { bolt, started } = yield* browser(() => fakeBolt());
			const target = yield* browser(() =>
				show({
					bolt,
					of: 'appointments',
					catalog: {
						appointments: {
							label: ['name'],
							fields: { name: { kind: 'text' } },
							syncs: { events: { kind: 'remote', with: 'google_calendar' } }
						}
					},
					actions: [
						{ icon: 'lucide:refresh-cw', name: 'Refresh', run: () => bolt.start('refresh', {}) }
					]
				})
			);
			yield* browser(open);
			yield* browser(() => press('sync:events'));
			assert.deepEqual(started, [{ automation: 'appointments.sync.events', input: {} }]);
			yield* browser(open);
			yield* browser(() => press('item:Refresh'));
			assert.deepEqual(started.at(-1), { automation: 'refresh', input: {} });
			assert.equal(document.querySelector('[data-view-menu]'), null);
			assert.ok(target.querySelector('[data-run]'), "the run's status");
		})
);

it.live("a model's import and export file syncs are rows of their own, run through the menu", () =>
	Effect.gen(function* () {
		const { bolt, started } = yield* browser(() => fakeBolt());
		const catalog: NonNullable<KindsHost['catalog']> = {
			jobs: {
				label: ['name'],
				fields: { name: { kind: 'text' } },
				syncs: { sheet: { kind: 'file', parser: ['json'], import: true, export: ['json'] } }
			}
		};
		const uploads: string[] = [];
		const upload: NonNullable<KindsHost['upload']> = (file, field) =>
			Effect.sync(() => {
				uploads.push(field);
				return { id: 'f1', name: file.name, mime: 'application/json' };
			});
		const target = yield* browser(() => show({ bolt, catalog, of: 'jobs', upload }));
		yield* browser(() => open());
		assert.ok(textOf(row('import:sheet')).includes('Import'));
		assert.equal(
			element<HTMLInputElement>(target, '[data-view-import]').accept,
			'.json,application/json'
		);
		yield* browser(() => press('export:sheet:json'));
		assert.deepEqual(started, [
			{ automation: 'jobs.sync.sheet', input: { mode: 'export', to: 'json' } }
		]);
		const input = element<HTMLInputElement>(target, '[data-view-import]');
		Object.defineProperty(input, 'files', {
			value: [new File(['[]'], 'jobs.json', { type: 'application/json' })],
			configurable: true
		});
		input.dispatchEvent(new Event('change', { bubbles: true }));
		yield* browser(() => settle());
		assert.deepEqual(uploads, ['jobs.$import.sheet']);
		assert.deepEqual(started.at(-1), {
			automation: 'jobs.sync.sheet',
			input: { mode: 'import', file: 'f1' }
		});
		assert.equal(target.querySelectorAll<HTMLElement>('[data-run]').length, 2);
	})
);

it.live(
	'an import run is watched to its end in one step: its counts are toasted and its warnings listed',
	() =>
		Effect.gen(function* () {
			const rows = new Map<string, RunRow>(),
				subs = new Set<() => void>();
			const set = (id: string, row: Omit<RunRow, 'id' | 'automation'>) => {
				rows.set(id, { id, automation: 'jobs.sync.sheet', ...row });
				for (const notify of subs) notify();
			};
			const runs: NonNullable<ViewBolt['runs']> = (_automation, { where }) => {
				const id = Schema.decodeUnknownSync(Schema.String)(jsonRecord(jsonRecord(where).id).eq);
				const page = (): Page<RunRow> => {
					const row = rows.get(id);
					return { rows: row === undefined ? [] : [row], next: null };
				};
				return Stream.callback<Page<RunRow>>((queue) =>
					Effect.gen(function* () {
						const notify = () => {
							Queue.offerUnsafe(queue, page());
						};
						subs.add(notify);
						notify();
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								subs.delete(notify);
							})
						);
					})
				);
			};
			const { bolt, started } = yield* browser(() => fakeBolt({ runs }));
			const catalog: NonNullable<KindsHost['catalog']> = {
				jobs: {
					label: ['name'],
					fields: { name: { kind: 'text' } },
					syncs: { sheet: { kind: 'file', import: true } }
				}
			};
			const target = yield* browser(() =>
				show({
					bolt,
					catalog,
					of: 'jobs',
					upload: (file) => Effect.succeed({ id: 'f1', name: file.name, mime: file.type })
				})
			);
			yield* browser(() => open());
			assert.ok(row('template:sheet'), 'the template row comes with the import');
			yield* browser(() => press('template:sheet'));
			assert.deepEqual(started.at(-1), {
				automation: 'jobs.sync.sheet',
				input: { mode: 'template' }
			});
			const input = element<HTMLInputElement>(target, '[data-view-import]');
			Object.defineProperty(input, 'files', {
				value: [new File(['x'], 'jobs.xlsx')],
				configurable: true
			});
			input.dispatchEvent(new Event('change', { bubbles: true }));
			yield* browser(() => settle());
			assert.deepEqual(started.at(-1), {
				automation: 'jobs.sync.sheet',
				input: { mode: 'import', file: 'f1' }
			});
			const first = `run-${started.length}`;
			set(first, { status: 'running' });
			yield* browser(() => settle());
			assert.equal(
				element<HTMLButtonElement>(document, '[data-view-actions]').getAttribute('aria-busy'),
				'true'
			);
			set(first, {
				status: 'succeeded',
				result: {
					applied: true,
					created: 2,
					updated: 1,
					deleted: 0,
					findings: [{ at: 3, field: 'Day', message: 'a holiday', severity: 'warn' }]
				}
			});
			yield* browser(() => settle());
			// one step: the import ran; its warnings come with its counts, and nothing is offered to accept
			assert.equal(started.length, 2);
			assert.ok(element<HTMLElement>(document, '[data-view-menu]'), 'the menu opens on warnings');
			assert.equal(row('import:sheet').dataset.status, 'done');
			assert.match(
				textOf(element<HTMLElement>(document, '[data-import-findings]')),
				/Row 3 · Day: a holiday/
			);
			assert.equal(document.querySelector('[data-import-accept]'), null);
			assert.deepEqual(
				toasts.map((t) => [t.tone, t.text]),
				[['success', '2 created, 1 updated, 0 deleted']]
			);
		})
);

it.live(
	'an import whose findings refuse says nothing was imported and lists them',
	() =>
		Effect.gen(function* () {
			const rows = new Map<string, RunRow>();
			const runs: NonNullable<ViewBolt['runs']> = (_automation, { where }) => {
				const id = Schema.decodeUnknownSync(Schema.String)(jsonRecord(jsonRecord(where).id).eq);
				const row = rows.get(id);
				return Stream.make({ rows: row === undefined ? [] : [row], next: null }).pipe(
					Stream.concat(Stream.never)
				);
			};
			rows.set('run-1', {
				id: 'run-1',
				automation: 'jobs.sync.sheet',
				status: 'succeeded',
				result: {
					applied: false,
					findings: [{ at: 2, field: 'hours', message: 'expected an integer', severity: 'refuse' }]
				}
			});
			const { bolt } = yield* browser(() => fakeBolt({ runs }));
			const catalog: NonNullable<KindsHost['catalog']> = {
				jobs: {
					label: ['name'],
					fields: { name: { kind: 'text' } },
					syncs: { sheet: { kind: 'file', import: true } }
				}
			};
			const target = yield* browser(() =>
				show({
					bolt,
					catalog,
					of: 'jobs',
					upload: (file) => Effect.succeed({ id: 'f1', name: file.name, mime: file.type })
				})
			);
			const input = element<HTMLInputElement>(target, '[data-view-import]');
			Object.defineProperty(input, 'files', {
				value: [new File(['x'], 'jobs.xlsx')],
				configurable: true
			});
			input.dispatchEvent(new Event('change', { bubbles: true }));
			yield* browser(() => settle());
			assert.equal(row('import:sheet').dataset.status, 'failed');
			assert.match(
				textOf(element<HTMLElement>(row('import:sheet'), '[data-menu-error]')),
				/Nothing was imported/
			);
			assert.match(
				textOf(element<HTMLElement>(document, '[data-import-findings]')),
				/Row 2 · Hours: expected an integer/
			);
			assert.equal(required(toasts.at(-1)).tone, 'error');
		})
);

// Custom record-header actions use the same feedback as generated forms and toolbar items.
it.live(
	'shared outcome feedback covers all action outcomes and honors localized success text',
	() =>
		Effect.gen(function* () {
			const { notify } = yield* browser(() => import('../src/actions/outcome.ts'));
			const bolt = { t: (key: string) => (key === 'Refused' ? key : 'Localized') };
			const outcomes: Outcome[] = [
				{ kind: 'committed', output: null, records: [] },
				{ kind: 'pendingApproval', requestId: 'request', records: [] },
				{ kind: 'refused', code: 'rule', message: 'Refused' },
				{ kind: 'conflict', records: [] },
				{ kind: 'unknown', invocation: 'retry-key' }
			];
			for (const outcome of outcomes) notify(bolt, outcome);
			assert.deepEqual(
				toasts.map((t) => t.tone),
				['success', 'info', 'error', 'error', 'warning']
			);
			assert.equal(required(toasts[0]).text, 'Localized');
			assert.equal(required(toasts[2]).text, 'Refused');
			notify(bolt, { kind: 'committed', output: null, records: [] }, 'Completed');
			assert.equal(required(toasts.at(-1)).text, 'Completed');
		})
);

it.live('a pending toolbar action is interrupted on teardown and releases every UI fiber', () =>
	Effect.gen(function* () {
		let interrupted = 0;
		yield* browser(() =>
			show({
				actions: [
					{
						icon: 'lucide:timer',
						name: 'Hold',
						run: () =>
							Effect.never.pipe(
								Effect.onInterrupt(() =>
									Effect.sync(() => {
										interrupted++;
									})
								)
							)
					}
				]
			})
		);
		yield* browser(open);
		yield* browser(() => press('item:Hold'));
		assert.equal(row('item:Hold').dataset.status, 'pending');
		assert.ok(runningFibers() > 0);
		const close = mounted.pop();
		assert.ok(close);
		yield* browser(close);
		yield* browser(settle);
		assert.equal(interrupted, 1);
		assert.equal(runningFibers(), 0);
	})
);

it.live(
	"a template run the toolbar started saves its file once; the toolbar's context rides on template and import runs",
	() =>
		Effect.gen(function* () {
			const rows = new Map<string, RunRow>(),
				subs = new Set<() => void>();
			const runs: NonNullable<ViewBolt['runs']> = (_automation, { where }) => {
				const id = Schema.decodeUnknownSync(Schema.String)(jsonRecord(jsonRecord(where).id).eq);
				return Stream.callback<Page<RunRow>>((queue) =>
					Effect.gen(function* () {
						const notify = () => {
							const row = rows.get(id);
							Queue.offerUnsafe(queue, { rows: row === undefined ? [] : [row], next: null });
						};
						subs.add(notify);
						notify();
						yield* Effect.addFinalizer(() => Effect.sync(() => void subs.delete(notify)));
					})
				);
			};
			const clicks: string[] = [];
			vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
				this: HTMLAnchorElement
			) {
				clicks.push(this.download);
			});
			const { bolt, started } = yield* browser(() => fakeBolt({ runs }));
			const target = yield* browser(() =>
				show({
					bolt,
					catalog: {
						jobs: {
							label: ['name'],
							fields: { name: { kind: 'text' } },
							syncs: { sheet: { kind: 'file', import: true } }
						}
					},
					of: 'jobs',
					context: { company_id: 'c1' },
					upload: (file) => Effect.succeed({ id: 'f1', name: file.name, mime: file.type })
				})
			);
			yield* browser(() => open());
			yield* browser(() => press('template:sheet'));
			assert.deepEqual(started.at(-1), {
				automation: 'jobs.sync.sheet',
				input: { mode: 'template', context: { company_id: 'c1' } }
			});
			const succeed = () => {
				rows.set('run-1', {
					id: 'run-1',
					automation: 'jobs.sync.sheet',
					status: 'succeeded',
					result: {
						file: {
							id: 'x1',
							name: 'jobs-template.xlsx',
							mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
						}
					}
				});
				for (const notify of subs) notify();
			};
			succeed();
			yield* browser(() => settle());
			succeed();
			yield* browser(() => settle());
			assert.deepEqual(clicks, ['jobs-template.xlsx']);
			vi.restoreAllMocks();
			const input = element<HTMLInputElement>(target, '[data-view-import]');
			Object.defineProperty(input, 'files', {
				value: [new File(['x'], 'jobs.xlsx')],
				configurable: true
			});
			input.dispatchEvent(new Event('change', { bubbles: true }));
			yield* browser(() => settle());
			assert.deepEqual(started.at(-1), {
				automation: 'jobs.sync.sheet',
				input: { mode: 'import', file: 'f1', context: { company_id: 'c1' } }
			});
		})
);
