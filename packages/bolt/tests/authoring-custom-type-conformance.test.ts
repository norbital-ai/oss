import { describe, expect, it } from 'vitest';
import { platformCustomTypes, type CustomTypeOutput } from '../src/authoring/index.js';
import { customValueJsonSchema } from '../src/runtime/collections/custom-values.js';

/**
 * A custom type's static value and the JSON Schema of the validator its writes pass through are one
 * contract seen twice: the type index and forms read the first, OpenAPI and agents the second. They
 * are asserted against one spelled-out shape each, so neither can drift without this failing.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const exact = <T extends true>(_witness: T): void => undefined;

describe('platform custom type conformance', () => {
	it('money: { value: number; currency: string } in the type and in the validator', () => {
		exact<
			Exact<
				CustomTypeOutput<typeof platformCustomTypes.money>,
				{ readonly value: number; readonly currency: string }
			>
		>(true);
		expect(customValueJsonSchema(platformCustomTypes.money, undefined)).toMatchObject({
			type: 'object',
			properties: { value: { type: 'number' }, currency: { type: 'string' } },
			required: ['value', 'currency'],
			additionalProperties: false
		});
	});

	it('instant_range: { start: string; end: string | null } in the type and in the validator', () => {
		exact<
			Exact<
				CustomTypeOutput<typeof platformCustomTypes.instant_range>,
				{ readonly start: string; readonly end: string | null }
			>
		>(true);
		const schema = customValueJsonSchema(platformCustomTypes.instant_range, undefined) as {
			readonly properties: Readonly<Record<string, unknown>>;
			readonly required: ReadonlyArray<string>;
		};
		expect(Object.keys(schema.properties).sort()).toEqual(['end', 'start']);
		expect([...schema.required].sort()).toEqual(['end', 'start']);
	});
});
