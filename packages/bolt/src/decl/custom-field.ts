// `customField('<name>', …)` (§3.3.2): a stored kind of the workspace's own, used as `{ kind: 'custom', of: '<name>' }`.
import type { Checked, Exact, InputKind, ValidInput, ValueOf } from './fields.ts';
import type { CustomFieldName, CustomShape } from './names.ts';
import type { Json, Msg } from './values.ts';

/** A custom field literal's data: what the manifest holds (`validate` is not data). */
type CustomFieldBase = {
	description: string;
	/** The value's shape: an input kind literal (usually an `object`, `list` or `union`). */
	shape: InputKind;
	label?: Msg;
	/** Include the value's text in the record's text search. */
	search?: true;
};
/** Field `N`'s stored value, from the generated names; any JSON until the first sync knows it. */
type ValueIn<N> = [CustomShape<N>] extends [never] ? Json : ValueOf<CustomShape<N>>;
/** Pure (no `ctx`): runs on every write of a value; a returned message refuses the write. */
type Validate<N> = (value: ValueIn<N>) => string | undefined;
/** The literal `customField(N, …)` takes: its data and the optional `validate`, typed from the generated names. */
type CustomFieldLiteral<N> = CustomFieldBase & { validate?: Validate<N> };
/** What `customField()` returns: the name, the literal, and `validate` as the guest calls it. */
export type CustomField<N extends string, S extends CustomFieldBase> = {
	readonly name: N;
	readonly spec: S;
	readonly check: Validate<N> | undefined;
};

/**
 * `src/data/custom_field/<f>/+definition.ts`: a reusable structured value (`shape`, an input kind literal) that model fields
 * store as `{ kind: 'custom', of: '<f>' }`, with an optional pure `validate` and a `+renderer.svelte` beside it.
 * @example
 * export default customField('address', {
 * 	description: 'A postal address.',
 * 	shape: { kind: 'object', fields: { line1: { kind: 'text' }, postcode: { kind: 'text' } } },
 * 	validate: (v) => (/^\d{6}$/.test(v.postcode) ? undefined : 'A postcode has six digits.')
 * });
 */
export function customField<const N extends CustomFieldName, const S extends CustomFieldLiteral<N>>(
	name: N,
	spec: S &
		NoInfer<
			Checked<
				CustomFieldLiteral<N>,
				S,
				Exact<
					S,
					{
						description: string;
						shape: ValidInput<S['shape']>;
						label?: Msg;
						search?: true;
						validate?: Validate<N>;
					}
				>
			>
		>
): CustomField<N, S> {
	return { name, spec, check: spec.validate };
}
