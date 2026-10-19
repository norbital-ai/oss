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
				}),
				{
					set: {
						lines: {
							create: [{ quantity: 2 }],
							update: [{ target: 'edited', set: { quantity: 4 } }],
							delete: ['removed'],
							link: ['linked'],
							unlink: ['unlinked']
						}
					},
					observed: { edited: 3, removed: 5, linked: 2, unlinked: 9 }
				}
			);
			assert.deepEqual(childOperations({}), { set: {}, observed: {} });
		})
);
it.effect('existing child operations reject missing or inconsistent snapshots', () =>
	Effect.sync(() => {
		assert.throws(
			() => childOperations({ lines: [{ action: 'delete', id: 'line', revision: 0 }] }),
			/original revision/
		);
		assert.throws(
			() =>
				childOperations({
					lines: [
						{ action: 'link', id: 'line', revision: 1 },
						{ action: 'unlink', id: 'line', revision: 2 }
					]
				}),
			/inconsistent/
		);
	})
);
