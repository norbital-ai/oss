import { expect, expectTypeOf, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { id_of, type Id } from '../src/index.ts';

it.effect(
	'id_of decodes a non-empty string into its model’s branded id and refuses anything else',
	() =>
		Effect.gen(function* () {
			const decode = Schema.decodeUnknownEffect(id_of('orders'));
			const id = yield* decode('019a0000-0000-7000-8000-000000000000');
			expectTypeOf(id).toEqualTypeOf<Id<'orders'>>();
			expectTypeOf(id).not.toEqualTypeOf<Id<'customers'>>();
			expect(id).toBe('019a0000-0000-7000-8000-000000000000');
			for (const bad of ['', 42, null, undefined, { id: 'x' }])
				expect((yield* Effect.flip(decode(bad)))._tag).toBe('SchemaError');
		})
);
