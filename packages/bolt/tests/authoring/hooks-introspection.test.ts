import { describe, expect, it } from 'vitest';
import { describeHooks } from '../../src/authoring/model-introspection.js';

const handler = async (input: unknown): Promise<unknown> => input;

describe('hook introspection', () => {
	it('names every declared operation and phase', () => {
		expect(
			describeHooks({
				mutate: {
					prepare: handler,
					perRecord: { before: { handler }, after: { handler } }
				},
				delete: { perRecord: { before: { handler } } }
			})
		).toEqual(['delete.before', 'mutate.after', 'mutate.before', 'mutate.prepare']);
	});

	it('counts leaves, not files — a module declaring five handlers is five hooks', () => {
		const declaration = {
			mutate: {
				prepare: handler,
				perRecord: { before: { handler }, after: { handler } }
			},
			delete: { perRecord: { before: { handler }, after: { handler } } }
		};
		expect(describeHooks(declaration)).toHaveLength(5);
	});

	it('ignores a phase that declares no handler', () => {
		expect(
			describeHooks({
				mutate: {
					perRecord: { before: { description: 'documented but not implemented' } }
				}
			})
		).toEqual([]);
	});

	it('answers an absent or malformed declaration with an empty list', () => {
		expect(describeHooks(undefined)).toEqual([]);
		expect(describeHooks(null)).toEqual([]);
		expect(describeHooks('hooks')).toEqual([]);
		expect(describeHooks({ mutate: 'before' })).toEqual([]);
		expect(describeHooks({ mutate: { prepare: { handler } } })).toEqual([]);
		expect(describeHooks({ delete: { perRecord: 'before' } })).toEqual([]);
	});

	it('is stable in order regardless of declaration order', () => {
		const forward = describeHooks({
			delete: { perRecord: { before: { handler } } },
			mutate: { perRecord: { after: { handler } } }
		});
		const reversed = describeHooks({
			mutate: { perRecord: { after: { handler } } },
			delete: { perRecord: { before: { handler } } }
		});
		expect(forward).toEqual(reversed);
	});
});
