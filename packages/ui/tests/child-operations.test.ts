import { Effect } from 'effect';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { childOperations } from '../src/form/child-operations.ts';

it.effect(
	'child commands retain explicit operations and original revisions without replacing a loaded list',
	() =>
		Effect.sync(() => {
			assert.deepEqual(
				childOperations({
					lines: [
						{ action: 'create', values: { quantity: 2 } },
						{ action: 'update', id: 'edited', revision: 3, set: { quantity: 4 } },
						{ action: 'delete', id: 'removed', revision: 5 },
						{ action: 'link', id: 'linked', revision: 2 },
						{ action: 'unlink', id: 'unlinked', revision: 9 }
					],
					untouched: []
				}, 'update'),
				{
					set: {
						lines: {
							create: [{ quantity: 2 }],
							update: [{ target: { id: 'edited', revision: 3 }, set: { quantity: 4 } }],
							delete: [{ id: 'removed', revision: 5 }],
							link: [{ id: 'linked', revision: 2 }],
							unlink: [{ id: 'unlinked', revision: 9 }]
						}
					}
				}
			);
			assert.deepEqual(childOperations({}, 'update'), { set: {} });
		})
);
it.effect('existing child operations reject missing snapshots and retain each explicit revision', () =>
	Effect.sync(() => {
		assert.throws(
			() => childOperations({ lines: [{ action: 'delete', id: 'line', revision: 0 }] }, 'update'),
			/original revision/
		);
		assert.deepEqual(
			childOperations({
					lines: [
						{ action: 'link', id: 'line', revision: 1 },
						{ action: 'unlink', id: 'line', revision: 2 }
					]
				}, 'update'),
			{ set: { lines: { link: [{ id: 'line', revision: 1 }], unlink: [{ id: 'line', revision: 2 }] } } }
		);
	})
);

it.effect('a new parent creates or links children and refuses edits to existing children', () =>
	Effect.sync(() => {
		assert.deepEqual(
			childOperations({ lines: [
				{ action: 'create', values: { quantity: 2 } },
				{ action: 'link', id: 'existing', revision: 4 }
			] }, 'create'),
			{ set: { lines: [{ quantity: 2 }, { id: 'existing', revision: 4 }] } }
		);
		for (const action of ['delete', 'unlink'] as const) {
			assert.throws(
				() => childOperations({ lines: [{ action, id: 'existing', revision: 4 }] }, 'create'),
				/A new parent creates or links/
			);
		}
		assert.throws(
			() => childOperations({ lines: [{ action: 'update', id: 'existing', revision: 4, set: { quantity: 3 } }] }, 'create'),
			/A new parent creates or links/
		);
	})
);
