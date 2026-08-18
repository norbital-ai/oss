import { describe, expect, it } from 'vitest';
import { describeHooks } from '../../src/authoring/model-introspection.js';

const handler = async (input: unknown): Promise<unknown> => input;

describe('hook introspection', () => {
	it('names every declared operation and phase', () => {
		expect(
			describeHooks({
				create: { before: { handler }, after: { handler } },
				update: { before: { handler } }
			})
		).toEqual(['create.after', 'create.before', 'update.before']);
	});

	it('counts leaves, not files — a module declaring five handlers is five hooks', () => {
		const declaration = {
			create: { before: { handler }, after: { handler } },
			update: { before: { handler }, after: { handler } },
			delete: { before: { handler } }
		};
		expect(describeHooks(declaration)).toHaveLength(5);
	});

	it('ignores a phase that declares no handler', () => {
		expect(
			describeHooks({ create: { before: { description: 'documented but not implemented' } } })
		).toEqual([]);
	});

	it('answers an absent or malformed declaration with an empty list', () => {
		expect(describeHooks(undefined)).toEqual([]);
		expect(describeHooks(null)).toEqual([]);
		expect(describeHooks('hooks')).toEqual([]);
		expect(describeHooks({ create: 'before' })).toEqual([]);
	});

	it('is stable in order regardless of declaration order', () => {
		const forward = describeHooks({
			update: { before: { handler } },
			create: { after: { handler } }
		});
		const reversed = describeHooks({
			create: { after: { handler } },
			update: { before: { handler } }
		});
		expect(forward).toEqual(reversed);
	});
});
