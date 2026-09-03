import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	custom,
	defineCustomType,
	defineModel,
	type CustomTypeOutput
} from '../src/authoring/index.js';
import type { TablesForModels } from '../src/authoring/internals.js';

declare module '../src/authoring/index.js' {
	interface WorkspaceAuthoringTypes {
		readonly customTypeValues: {
			readonly leave_event: unknown;
			readonly pay_component_policy: unknown;
		};
	}
}

/**
 * The value type a generated custom-type renderer states for its props.
 *
 * `renderCustomTypeRenderer` used to emit `z.infer<CustomTypeResolvedSchema<typeof definition>>`,
 * which made every workspace with one custom renderer depend on zod to name its own value. It now
 * emits `CustomTypeOutput`, which resolves the factory form the same way and reads the value type
 * off `~standard` — so the declaration and the renderer agree without either naming a library.
 *
 * These are compile-time assertions, and they live here because nothing else can make them: the
 * templates that exercise this path resolve `@norbital-ai/bolt` from a `.yalc` snapshot, so their
 * type-checks cannot see this change until it is republished. `Exact` is two-way — a one-way
 * `extends` would pass on `any`, which is exactly the failure mode a type-level test exists to
 * catch.
 */

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const exact = <T extends true>(_witness: T): void => undefined;

const plain = defineCustomType({
	name: 'leave_event',
	description: 'One leave event.',
	schema: Schema.toStandardSchemaV1(
		Schema.Struct({ kind: Schema.Literal('ANNUAL'), days: Schema.Finite })
	)
});

// The factory form, as `hr-payroll` writes it: the schema is a function of authored options, and
// the renderer's value type is the *returned* schema's output rather than the function's.
const factory = defineCustomType({
	name: 'pay_component_policy',
	description: 'One pay component policy.',
	schema: (options: { readonly currencies: ReadonlyArray<string> }) =>
		Schema.toStandardSchemaV1(
			Schema.Struct({
				currency: Schema.String,
				rate: Schema.Finite,
				allowed: Schema.Literal(options.currencies.length)
			})
		)
});

exact<Exact<CustomTypeOutput<typeof plain>, { readonly kind: 'ANNUAL'; readonly days: number }>>(
	true
);
exact<
	Exact<
		CustomTypeOutput<typeof factory>,
		{ readonly currency: string; readonly rate: number; readonly allowed: number }
	>
>(true);

const priced = defineModel({ amount: custom('money') });
type PricedRow = TablesForModels<{ readonly priced: typeof priced }>['priced']['$inferSelect'];
exact<Exact<PricedRow['amount'], { readonly value: number; readonly currency: string } | null>>(
	true
);

const scheduled = defineModel({ ranges: custom('instant_range', { multiple: true }) });
type ScheduledRow = TablesForModels<{
	readonly scheduled: typeof scheduled;
}>['scheduled']['$inferSelect'];
exact<
	Exact<
		ScheduledRow['ranges'],
		ReadonlyArray<{ readonly start: string; readonly end: string | null }> | null
	>
>(true);

const undeclaredCustomTypeDoesNotCompile = (): void => {
	// @ts-expect-error — the generated platform + tenant datatype union is closed.
	custom('undeclared_type');
};
void undeclaredCustomTypeDoesNotCompile;

describe('custom type renderer value types', () => {
	// The type assertions above are the subject; this keeps them inside a suite that runs, so a file
	// that stopped being compiled would stop being reported as passing too.
	it('resolves an Effect-declared custom type, in both the plain and factory forms', () => {
		expect(plain.name).toBe('leave_event');
		expect(factory.name).toBe('pay_component_policy');
	});
});
