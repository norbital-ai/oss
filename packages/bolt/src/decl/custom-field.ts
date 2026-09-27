// `customField()` (§3.3.2): a stored kind of the workspace's own, used as `{ kind: 'custom', of: '<f>' }`.
import type { Checked, Exact, InputKind, ValidInput, ValueOf } from './fields.ts';
import type { Msg } from './values.ts';

type CustomFieldBase = {
	description: string;
	/** The value's shape: an input kind literal (usually an `object`, `list` or `union`). */
	shape: InputKind;
	label?: Msg;
	/** Include the value's text in the record's text search. */
	search?: true;
};
export type CustomField<S extends CustomFieldBase> = {
	readonly spec: S;
	/** At most once; a returned message refuses the write. Pure: no `ctx`. */
	validate(check: (value: ValueOf<S['shape']>) => string | undefined): void;
	/** The attached check, read by the compiler. */
	readonly check: ((value: ValueOf<S['shape']>) => string | undefined) | undefined;
};

/**
 * `src/data/custom_field/<f>/+definition.ts`: a reusable structured value (`shape`, an input kind literal) that model fields
 * store as `{ kind: 'custom', of: '<f>' }`, with an optional `f.validate` check and a `+renderer.svelte`.
 * @example
 * const address = customField({
 * 	description: 'A postal address.',
 * 	shape: { kind: 'object', fields: { line1: { kind: 'text' }, postcode: { kind: 'text' } } }
 * });
 * export default address;
 * address.validate((v) => (/^\d{6}$/.test(v.postcode) ? undefined : 'A postcode has six digits.'));
 */
export function customField<const S extends CustomFieldBase>(
	spec: S & Checked<CustomFieldBase, S, Exact<S, { description: string; shape: ValidInput<S['shape']>; label?: Msg; search?: true }>>
): CustomField<S> {
	let check: CustomField<S>['check'];
	return {
		spec,
		validate(body) {
			if (check !== undefined) throw new Error('customField: validate is attached twice');
			check = body;
		},
		get check() {
			return check;
		}
	};
}
