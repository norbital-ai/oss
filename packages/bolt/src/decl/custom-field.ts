// `custom_field(spec)`: a stored kind of the workspace's own, used as `{ kind: 'custom', of: '<name>' }`.
import type { Checked, Exact, InputKind, ValidInput, ValueOf } from './fields.ts';
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
/** Pure validation runs on every write and can refuse the value with a message. */
type Validate<Shape extends InputKind> = (
	value: InputKind extends Shape ? Json : ValueOf<Shape>
) => string | undefined;
type CustomFieldLiteral<Shape extends InputKind> = Omit<CustomFieldBase, 'shape'> & {
	shape: Shape;
	validate?: Validate<Shape>;
};
/** A custom field literal and the validator the guest calls. The source path supplies its name. */
export type CustomField<Shape extends InputKind, S extends CustomFieldLiteral<Shape>> = {
	readonly spec: S;
	readonly check: Validate<Shape> | undefined;
};

/**
 * `src/data/custom_field/<f>/+definition.ts`: a reusable structured value (`shape`, an input kind literal) that model fields
 * store as `{ kind: 'custom', of: '<f>' }`, with an optional pure `validate` and a `+renderer.svelte` beside it.
 * It is an inline value, not an entity: use a model when identity, lifecycle, authority, history or relational queries
 * need one. Without a renderer the value is shown and edited from its `shape`; a renderer (`CustomFieldView`) is used
 * in table cells, board cards, forms, record fields, history diffs and pickers, and is bundled statically, so keep it
 * light. The built-in names `money`, `file`, `point` and `phone` are reserved.
 * @example
 * export default custom_field({
 * 	description: 'A postal address.',
 * 	shape: { kind: 'object', fields: { line1: { kind: 'text' }, postcode: { kind: 'text' } } },
 * 	validate: (v) => (/^\d{6}$/.test(v.postcode) ? undefined : 'A postcode has six digits.')
 * });
 */
export function custom_field<
	const Shape extends InputKind,
	const S extends CustomFieldLiteral<Shape>
>(
	spec: { shape: Shape } & S &
		NoInfer<
			Checked<
				CustomFieldLiteral<Shape>,
				S,
				Exact<S, Omit<CustomFieldLiteral<Shape>, 'shape'> & { shape: ValidInput<Shape> }>
			>
		>
): CustomField<Shape, S> {
	return { spec, check: spec.validate };
}
