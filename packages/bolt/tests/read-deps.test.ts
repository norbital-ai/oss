import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { catalog_of, read } from '@norbital-ai/store';
import { readTargets } from '../src/engine/query/engine.ts';

it.effect('tracks a live label reference so target edits refresh approval results', () =>
	Effect.gen(function* () {
		const cat = catalog_of({
			tables: {
				people: { fields: { name: { kind: 'text' } }, record_label: 'record.name' },
				requests: {
					fields: { model: { kind: 'text' }, record: { kind: 'text' } },
					label_link: { model: 'model', record: 'record', targets: ['people'] }
				}
			}
		});
		const query = yield* read(cat, 'requests', { select: { model: true }, limit: 1 });
		expect([...readTargets(cat, query)].sort()).toEqual(['people', 'requests']);
	})
);

it.effect('tracks every polymorphic projection arm and its nested relations', () =>
	Effect.gen(function* () {
		const cat = catalog_of({
			tables: {
				account: { fields: { name: { kind: 'text' } } },
				order: {
					fields: {
						number: { kind: 'text' },
						account: { kind: 'ref', to: 'account', inverse: 'orders' }
					}
				},
				line: {
					fields: {
						sku: { kind: 'text' },
						order: { kind: 'ref', to: 'order', inverse: 'lines' }
					}
				},
				note: {
					fields: { about: { kind: 'ref', to: ['account', 'order'] }, body: { kind: 'text' } }
				}
			}
		});
		const query = yield* read(cat, 'note', {
			select: { body: true },
			with: {
				about: {
					account: { select: { name: true } },
					order: { select: { number: true }, with: { lines: { all: true, select: { sku: true } } } }
				}
			},
			all: true
		});
		if (query.kind !== 'read') throw new Error('Expected a list read');
		expect([...readTargets(cat, query)].sort()).toEqual(['account', 'line', 'note', 'order']);
	})
);
