import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import { viewFixture, jsonRecord, type ViewScript, browser } from './view-fixture.ts';
import { Deferred, Effect, Queue, Schema, Stream } from 'effect';
// The toolbar's ⚡ menu: an author item is an icon, a name, a description and its handler; the menu keeps each row's
// state (pending, done, failed in place and as a toast) and wires a collection's pipeline in by itself.
import './dom.ts';
import assert from 'node:assert/strict';
import type { Json } from '@norbital-ai/std/wire';
import type { Value } from '@norbital-ai/std/kind';
import { Decimal } from '@norbital-ai/std/decimal';
import type { KindsHost } from '../src/kinds/context.ts';
import type { ViewBolt, Outcome, RunRow } from '../src/client/contract.ts';
import type { Page } from '../src/collection/types.ts';
import type { TableSource, TableProps } from '../src/table/Table.svelte';
import type { Toolbar, ToolbarItem } from '../src/collection/ViewToolbar.svelte';
import { ActRefused } from '../../bolt/build/decl/errors.js';
import { runningFibers } from '../src/effect/index.ts';
import { it, afterEach } from '@effect/vitest';
import { vi } from 'vitest';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
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
		aggregate: () => [{ count: 0 }],
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
	'CSV exports retain value rows without IDs, order, quoting and collection reference labels',
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

it.live('a row shows its icon tile, name, description and one button named for it', () =>
	Effect.gen(function* () {
		yield* browser(() =>
			show({
				actions: [
					{ icon: 'lucide:check', name: 'Settle', description: 'Mark the dues paid', run: () => {} }
				]
			})
		);
		yield* browser(() => open());
		const r = row('item:Settle');
		assert.ok(textOf(r).includes('Settle') && textOf(r).includes('Mark the dues paid'));
		assert.equal(element<HTMLButtonElement>(r, 'button').getAttribute('aria-label'), 'Settle');
		assert.equal(textOf(element<HTMLButtonElement>(r, 'button')).trim(), 'Run');
	})
);

it.live('a pending handler spins and disables its row, then says done; the menu stays open', () =>
	Effect.gen(function* () {
		const d = yield* Deferred.make<void>();
		let calls = 0;
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
					}
				]
			})
		);
		yield* browser(() => open());
		yield* browser(() => press('item:Settle'));
		assert.equal(row('item:Settle').dataset.status, 'pending');
		assert.equal(element<HTMLButtonElement>(row('item:Settle'), 'button').disabled, true);
		assert.ok(element<HTMLElement>(row('item:Settle'), '[role=status]'), 'a spinner');
		assert.equal(
			element<HTMLButtonElement>(document, '[data-view-actions]').getAttribute('aria-busy'),
			'true'
		);
		yield* Deferred.succeed(d, undefined);
		yield* browser(() => settle());
		assert.equal(row('item:Settle').dataset.status, 'done');
		assert.ok(textOf(element<HTMLButtonElement>(row('item:Settle'), 'button')).includes('Done'));
		assert.equal(calls, 1);
	})
);

it.live('a rejected handler shows its error in place and as a toast, and can run again', () =>
	Effect.gen(function* () {
		let fail = true;
		yield* browser(() =>
			show({
				actions: [
					{
						icon: 'lucide:check',
						name: 'Settle',
						description: 'Mark paid',
						run: () =>
							Effect.suspend(() =>
								fail ? Effect.fail(new Error('Ledger is locked')) : Effect.succeed(undefined)
							)
					}
				]
			})
		);
		yield* browser(() => open());
		yield* browser(() => press('item:Settle'));
		assert.equal(row('item:Settle').dataset.status, 'failed');
		assert.equal(
			textOf(element<HTMLElement>(row('item:Settle'), '[data-menu-error]')),
			'Ledger is locked'
		);
		assert.deepEqual(
			toasts.map((t) => [t.tone, t.text]),
			[['error', 'Ledger is locked']]
		);
		fail = false;
		yield* browser(() => press('item:Settle'));
		assert.equal(row('item:Settle').dataset.status, 'done');
		assert.equal(row('item:Settle').querySelector('[data-menu-error]'), null);
	})
);

it.live("an outcome is toasted; a refusal is the row's error", () =>
	Effect.gen(function* () {
		yield* browser(() =>
			show({
				actions: [
					{
						icon: 'lucide:check',
						name: 'Hold',
						run: () => Effect.succeed({ kind: 'committed', output: null, records: [] })
					},
					{
						icon: 'lucide:x',
						name: 'Release',
						run: () => Effect.fail(new ActRefused({ code: 'refused', message: 'Already paid' }))
					}
				]
			})
		);
		yield* browser(() => open());
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
	})
);

it.live(
	'a handler returning a run handle shows the run under the toolbar and closes the menu',
	() =>
		Effect.gen(function* () {
			const { bolt, started } = yield* browser(() => fakeBolt());
			const target = yield* browser(() =>
				show({
					bolt,
					actions: [
						{ icon: 'lucide:refresh-cw', name: 'Refresh', run: () => bolt.start('refresh', {}) }
					]
				})
			);
			yield* browser(() => open());
			yield* browser(() => press('item:Refresh'));
			assert.deepEqual(started, [{ automation: 'refresh', input: {} }]);
			assert.equal(document.querySelector('[data-view-menu]'), null);
			assert.ok(element<HTMLElement>(target, '[data-run="run-1"]'), "the run's status");
			assert.deepEqual(toasts, [], 'the run says its own success');
		})
);

it.live('a handler returning nothing closes the menu (it opened its own surface)', () =>
	Effect.gen(function* () {
		let opened = false;
		yield* browser(() =>
			show({
				actions: [
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
		yield* browser(() => open());
		yield* browser(() => press('item:Waive'));
		assert.equal(opened, true);
		assert.equal(document.querySelector('[data-view-menu]'), null);
	})
);

it.live(
	'sync starts the declared integration feed instead of inferring a run from the collection name',
	() =>
		Effect.gen(function* () {
			const { bolt, started } = yield* browser(() => fakeBolt());
			yield* browser(() =>
				show({
					bolt,
					of: 'appointments',
					catalog: {
						appointments: {
							label: ['name'],
							fields: { name: { kind: 'text' } },
							integration: 'google_calendar.events'
						}
					}
				})
			);
			yield* browser(() => open());
			yield* browser(() => press('sync'));
			assert.deepEqual(started, [{ automation: 'google_calendar.events', input: {} }]);
		})
);

it.live(
	"a collection's import and export pipelines are rows of their own, run through the menu",
	() =>
		Effect.gen(function* () {
			const { bolt, started } = yield* browser(() => fakeBolt());
			const catalog: NonNullable<KindsHost['catalog']> = {
				jobs: {
					label: ['name'],
					fields: { name: { kind: 'text' } },
					pipeline: { import: 'Jobs from a JSON file', export: 'Every job as JSON' }
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
			assert.ok(textOf(row('import')).includes('Jobs from a JSON file'));
			yield* browser(() => press('export-pipeline'));
			assert.deepEqual(started, [{ automation: 'jobs.pipeline', input: { mode: 'export' } }]);
			const input = element<HTMLInputElement>(target, '[data-view-import]');
			Object.defineProperty(input, 'files', {
				value: [new File(['[]'], 'jobs.json', { type: 'application/json' })],
				configurable: true
			});
			input.dispatchEvent(new Event('change', { bubbles: true }));
			yield* browser(() => settle());
			assert.deepEqual(uploads, ['jobs.$import']);
			assert.deepEqual(started.at(-1), {
				automation: 'jobs.pipeline',
				input: { mode: 'import', file: 'f1' }
			});
			assert.equal(target.querySelectorAll<HTMLElement>('[data-run]').length, 2);
		})
);

it.live(
	'an import run is watched to its end: warnings wait in the menu, "Accept and import" re-submits the file, the counts are toasted',
	() =>
		Effect.gen(function* () {
			const rows = new Map<string, RunRow>(),
				subs = new Set<() => void>();
			const set = (id: string, row: Omit<RunRow, 'id' | 'automation'>) => {
				rows.set(id, { id, automation: 'jobs.pipeline', ...row });
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
					pipeline: { import: 'Jobs from a sheet' }
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
			assert.ok(row('template'), 'the template row comes with the import');
			yield* browser(() => press('template'));
			assert.deepEqual(started.at(-1), {
				automation: 'jobs.pipeline',
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
				automation: 'jobs.pipeline',
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
					applied: false,
					findings: [{ row: 3, column: 'Day', message: 'a holiday', severity: 'warn' }]
				}
			});
			yield* browser(() => settle());
			assert.ok(element<HTMLElement>(document, '[data-view-menu]'), 'the menu opens on findings');
			assert.equal(row('import').dataset.status, 'review');
			assert.match(
				textOf(element<HTMLElement>(document, '[data-import-findings]')),
				/Row 3 · Day: a holiday/
			);
			element<HTMLButtonElement>(document, '[data-import-accept]').click();
			yield* browser(() => settle());
			assert.deepEqual(started.at(-1), {
				automation: 'jobs.pipeline',
				input: { mode: 'import', file: 'f1', accept: true }
			});
			set(`run-${started.length}`, {
				status: 'succeeded',
				result: { applied: true, created: 2, updated: 1, deleted: 0, findings: [] }
			});
			yield* browser(() => settle());
			assert.equal(row('import').dataset.status, 'done');
			assert.deepEqual(
				toasts.map((t) => [t.tone, t.text]),
				[['success', '2 created, 1 updated, 0 deleted']]
			);
		})
);

it.live(
	'an import whose findings refuse says nothing was imported, lists them, and offers no accept',
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
				automation: 'jobs.pipeline',
				status: 'succeeded',
				result: {
					applied: false,
					findings: [
						{ row: 2, column: 'hours', message: 'expected an integer', severity: 'refuse' }
					]
				}
			});
			const { bolt } = yield* browser(() => fakeBolt({ runs }));
			const catalog: NonNullable<KindsHost['catalog']> = {
				jobs: {
					label: ['name'],
					fields: { name: { kind: 'text' } },
					pipeline: { import: 'Jobs from a sheet' }
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
			assert.equal(row('import').dataset.status, 'failed');
			assert.match(
				textOf(element<HTMLElement>(row('import'), '[data-menu-error]')),
				/Nothing was imported/
			);
			assert.match(
				textOf(element<HTMLElement>(document, '[data-import-findings]')),
				/Row 2 · hours: expected an integer/
			);
			assert.equal(document.querySelector('[data-import-accept]'), null);
			assert.equal(required(toasts.at(-1)).tone, 'error');
		})
);

it.live("the toolbar's context rides on the pipeline's template and import runs", () =>
	Effect.gen(function* () {
		const { bolt, started } = yield* browser(() => fakeBolt());
		const catalog: NonNullable<KindsHost['catalog']> = {
			jobs: {
				label: ['name'],
				fields: { name: { kind: 'text' } },
				pipeline: { import: 'Jobs from a sheet' }
			}
		};
		const target = yield* browser(() =>
			show({
				bolt,
				catalog,
				of: 'jobs',
				context: { company_id: 'c1' },
				upload: (file) => Effect.succeed({ id: 'f1', name: file.name, mime: file.type })
			})
		);
		yield* browser(() => open());
		yield* browser(() => press('template'));
		assert.deepEqual(started.at(-1), {
			automation: 'jobs.pipeline',
			input: { mode: 'template', context: { company_id: 'c1' } }
		});
		const input = element<HTMLInputElement>(target, '[data-view-import]');
		Object.defineProperty(input, 'files', {
			value: [new File(['x'], 'jobs.xlsx')],
			configurable: true
		});
		input.dispatchEvent(new Event('change', { bubbles: true }));
		yield* browser(() => settle());
		assert.deepEqual(started.at(-1), {
			automation: 'jobs.pipeline',
			input: { mode: 'import', file: 'f1', context: { company_id: 'c1' } }
		});
	})
);

// Custom record-header actions use the same feedback as generated forms and toolbar items.
it.live(
	'shared outcome feedback covers all action outcomes and honors localized success text',
	() =>
		Effect.gen(function* () {
			const { notify } = yield* browser(() => import('../src/actions/notify.ts'));
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
