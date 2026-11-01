import './dom.ts';
import assert from 'node:assert/strict';
import { it, vi } from '@effect/vitest';
import { browser, viewFixture, type ReadOptions } from './view-fixture.ts';
import type { KindsHost } from '../src/kinds/context.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Table } = await import('../src/table/Table.svelte');
const { default: Board } = await import('../src/board/Board.svelte');
const catalog = {
	jobs: {
		label: ['title', 'code'],
		record_label: "record.code + ' · ' + record.title",
		labelPaths: ['code', 'title'],
		fields: {
			title: { kind: 'text' },
			code: { kind: 'text' },
			status: { kind: 'enum', values: ['todo'] }
		}
	}
} satisfies NonNullable<KindsHost['catalog']>;

for (const identifier of ['label', 'uuid'] as const)
	for (const part of ['table', 'board'] as const)
		it.live(`${part} uses the ${identifier} identifier and reads its dependencies`, () =>
			browser(async () => {
				const reads: ReadOptions[] = [];
				const id = '0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b';
				const { record_label: _expression, labelPaths: _paths, ...unlabelled } = catalog.jobs;
				const metadata = identifier === 'label' ? catalog : { jobs: { ...unlabelled, label: [] } };
				const { bolt } = await viewFixture({
					read: (_model, options) => {
						reads.push(options);
						const row = { id, title: 'Pump', code: 'JOB-7', status: 'todo' };
						return {
							rows: [
								Object.fromEntries(
									Object.entries(row).filter(
										([key]) => key === 'id' || options.fields?.includes(key)
									)
								)
							],
							next: null
						};
					},
					aggregate: () => ({ rows: [{ key: { status: 'todo' }, count: 1 }], next: null })
				});
				const target = document.body.appendChild(document.createElement('div'));
				const toolbar = {
					title: false,
					search: false,
					filter: false,
					export: false,
					new: false
				} as const;
				const app = mount(Harness, {
					target,
					props: {
						bolt,
						catalog: metadata,
						...(part === 'table'
							? { part, view: Table, props: { of: 'jobs', columns: ['title'], toolbar } }
							: {
									part,
									view: Board,
									props: { of: 'jobs', by: 'status', card: ['title'], toolbar }
								})
					}
				});
				try {
					await vi.waitFor(async () => {
						flushSync();
						await tick();
						assert.ok(
							[...target.querySelectorAll('[data-record-label]')].some(
								(node) => node.textContent === (identifier === 'label' ? 'JOB-7 · Pump' : id)
							)
						);
					});
					assert.ok(reads.some((read) => read.fields?.includes('code')));
				} finally {
					await unmount(app);
					target.remove();
					localStorage.clear();
				}
			})
		);
