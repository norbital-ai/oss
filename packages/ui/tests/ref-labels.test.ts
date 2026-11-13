// A relation its output reads as no layer (an `owner` onto `sys_user`) shows its target's label, read by id in one
// read after the page, never the raw id.
import './dom.ts';
import assert from 'node:assert/strict';
import { it, vi } from '@effect/vitest';
import { browser, viewFixture, type ReadOptions } from './view-fixture.ts';
import type { KindsHost } from '../src/kinds/context.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Table } = await import('../src/table/Table.svelte');
const { default: Board } = await import('../src/board/Board.svelte');
const owner = '0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b';
const catalog = {
	orders: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			status: { kind: 'enum', values: ['open'] },
			owner: { kind: 'ref', to: 'sys_user' }
		},
		relations: { owner: { targets: ['sys_user'] } }
	},
	sys_user: {
		label: ['name'],
		record_label: 'record.name',
		label_paths: ['name'],
		fields: { name: { kind: 'text' } }
	}
} satisfies NonNullable<KindsHost['catalog']>;

for (const part of ['table', 'board'] as const)
	it.live(`a ${part} labels an unlayered user relation`, () =>
		browser(async () => {
			const reads: { model: string; options: ReadOptions }[] = [];
			const { bolt } = await viewFixture({
				catalog,
				read: (model, options) => {
					reads.push({ model, options });
					return model === 'sys_user'
						? { rows: [{ id: owner, name: 'Ada Lovelace' }], next: null }
						: {
								rows: [{ id: 'o1', revision: 1, title: 'First order', status: 'open', owner }],
								next: null
							};
				},
				aggregate: () => ({ rows: [{ key: { status: 'open' }, count: 1 }], next: null })
			});
			const target = document.body.appendChild(document.createElement('div'));
			const toolbar = { title: false, search: false, filter: false, export: false, new: false } as const;
			const app = mount(Harness, {
				target,
				props: {
					bolt,
					catalog,
					...(part === 'table'
						? { part, view: Table, props: { of: 'orders', columns: ['title', 'owner'], toolbar } }
						: { part, view: Board, props: { of: 'orders', by: 'status', card: ['title', 'owner'], toolbar } })
				}
			});
			try {
				await vi.waitFor(async () => {
					flushSync();
					await tick();
					assert.ok(target.textContent?.includes('Ada Lovelace'));
				});
				assert.ok(!target.textContent?.includes(owner));
				const labelReads = reads.filter((read) => read.model === 'sys_user');
				assert.equal(labelReads.length, 1);
				assert.deepEqual(labelReads[0]?.options.where, { id: { in: [owner] } });
			} finally {
				await unmount(app);
				target.remove();
				localStorage.clear();
			}
		})
	);
