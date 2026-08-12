import { describe, expect, it } from 'vitest';
import { CreateManyWireSchema } from '@norbital-ai/platform-utils/remote/collection_wire_schemas';

describe('createMany wire projection', () => {
	it('accepts an id-only response request without changing the default', () => {
		const input = { collection: 'records', inputs: [{ title: 'one' }] };
		expect(CreateManyWireSchema.parse(input)).toEqual(input);
		expect(CreateManyWireSchema.parse({ ...input, returning: 'ids' }).returning).toBe('ids');
		expect(() => CreateManyWireSchema.parse({ ...input, returning: 'nothing' })).toThrow();
	});
});
