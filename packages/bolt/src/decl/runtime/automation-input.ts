// Automation selection fields cross as ids and reach the body as rows loaded under its declared policies.
import { Schema } from 'effect';
import { type Fields, type Kind } from '@norbital-ai/std/kind';
import type { InputKind, InputOf, ValidInput } from '../fields.ts';
import { FieldData } from '../field-data.ts';
import type { ReadableName } from '../names.ts';

type RowsInput = { readonly kind: 'rows'; readonly of: string; readonly optional?: true };
export type AutomationInputFields = Readonly<Record<string, InputKind | RowsInput>>;
export type ValidAutomationInputs<F> = {
	[K in keyof F]: F[K] extends { kind: 'rows' }
		? { readonly kind: 'rows'; readonly of: ReadableName; readonly optional?: true }
		: ValidInput<F[K]>;
};
type InputFieldsFor<F, Loaded extends boolean> = {
	[K in keyof F]: F[K] extends { kind: 'rows'; of: infer Model }
		? Omit<F[K], 'kind' | 'of'> & { readonly many: true } & (Loaded extends true
			? { readonly kind: 'row'; readonly of: Model }
			: { readonly kind: 'ref'; readonly to: Model })
		: F[K];
};
export type AutomationInputOf<F, Loaded extends boolean = true> = InputOf<InputFieldsFor<F, Loaded>>;
const RowsInputSchema = Schema.Struct({
	kind: Schema.Literal('rows'),
	of: Schema.NonEmptyString,
	optional: Schema.optionalKey(Schema.Literal(true))
});
export const AutomationInputSchema = Schema.Record(Schema.String, Schema.Union([FieldData, RowsInputSchema]));
/** The ordinary kind codecs and native pickers validate ids; only the automation body receives loaded values. */
export function automation_fields(input: typeof AutomationInputSchema.Type | undefined): Fields {
	return Object.fromEntries(Object.entries(input ?? {}).map(([name, kind]): [string, Kind] => [name,
		kind.kind === 'rows'
			? { kind: 'ref', to: kind.of, many: true, ...(kind.optional === undefined ? {} : { optional: kind.optional }) }
			: kind
	]));
}
