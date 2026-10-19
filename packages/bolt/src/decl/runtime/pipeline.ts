// `pipeline('<collection>', spec)`: file import and export of one collection (`src/data/collection/<c>/+pipeline.ts`).
// An import maps an upload's records onto inserts that enter through the collection's write pipeline as the caller; an
// export writes selected fields as a file. Its bodies run in the guest with the caller's reads and no I/O.
import { attached } from '../collection.ts';
import type { BodyReturn, CallerReads, Insert, Keyed, QueryCtx } from '../ctx.ts';
import type { Checked, Exact, InputFields, InputOf, ValidInputs } from '../fields.ts';
import type {
	CollectionSpecOf,
	ColumnValue,
	ModelName,
	ReadField,
	WritableField
} from '../names.ts';
import type { Where } from '../where.ts';
import type { NonEmpty } from '../values.ts';

/** What a pipeline's `known`, `check` and `template` bodies see: the clock and the caller's reads; no I/O. */
export type PipelineCtx = Pick<QueryCtx, 'now' | 'today' | 'tz'> &
	Pick<CallerReads, 'read' | 'get'>;

/** A problem an import found with one sheet row (`row` null: the whole file or a stored row): `refuse` blocks the file, `warn` waits for acceptance. */
export type ImportFinding = {
	readonly row: number | null;
	readonly column: string;
	readonly message: string;
	readonly severity: 'warn' | 'refuse';
};
/** One sheet cell's value as a template row holds it. */
type TemplateCell = string | number | boolean | null;
/** What `known`, `map`, `related` and `check` receive beside the record: the page's context, decoded against `context`. */
type Context<X> = { readonly context: InputOf<X> };
type ImportSpec<C, I, Rec, M, K, X> = {
	description: CollectionSpecOf<C> extends { create: unknown }
		? string
		: `error: ${C & string} exposes no create, so nothing can be imported`;
	/**
	 * The import's input: a JSON upload decodes against it as is. An xlsx upload fills the input's one list of objects: the
	 * header row names its fields (by name or `label`), each later row is an item, blank cells are left out, and a
	 * `row: { kind: 'number' }` field receives the sheet row number.
	 */
	input: I & Checked<InputFields, I, Exact<I, ValidInputs<I>>>;
	/**
	 * What the view the import runs from is looking at (an entity, a period): the page passes it as its toolbar's
	 * `context`, and it decodes against these fields like any input. It narrows and defaults; it never authorizes.
	 */
	context?: X & Checked<InputFields, X, Exact<X, ValidInputs<X>>>;
	/** The records of one upload, from its input (a parsed file, a pasted list). */
	records: (input: InputOf<I>) => readonly Rec[];
	/**
	 * One resolver per upload, read as the caller, before any row is mapped: what the records' keys name (employee
	 * numbers to employments, codes to ids, an entity's time zone). Its value reaches `map`, `related` and `check` as `known`.
	 */
	known?: (ctx: PipelineCtx, records: readonly Rec[], x: Context<X>) => BodyReturn<K>;
	/** `null` skips the record. */
	// `M` keeps the returned literal checkable: an inferred callback's return is otherwise never excess-checked
	map: (record: Rec, x: { known: K } & Context<X>) => (M & Exact<M, Insert<C>>) | null;
	/**
	 * Rows of other collections a record also writes (a day of time off for a leave code), each created as the caller
	 * in the import's one act: one refusal anywhere refuses the whole file.
	 */
	related?: {
		[R in ModelName]?: (record: Rec, x: { known: K } & Context<X>) => readonly Insert<R>[];
	};
	/**
	 * The import is a set over a scope: per distinct `by` values (and, with `range`, from that group's first to its last
	 * `range` value), every stored row in scope the import does not name by the collection's key is deleted, in the same
	 * act. The groups come from `of(record)` for every record, a blank one included (a day the sheet empties is in scope
	 * and so deleted); without `of`, from the mapped rows. The collection's guards judge the deletes: its transform (with
	 * `delete: { transform: true }`), its state locks and its grants; one refusal refuses the whole file.
	 */
	scope?: {
		by: NonEmpty<WritableField<C>>;
		range?: WritableField<C>;
		of?: (
			record: Rec,
			x: { known: K } & Context<X>
		) => { readonly [F in WritableField<C>]?: ColumnValue<C, F> } | null;
	};
	/** Findings over the mapped rows (`rows[i]` is `map(records[i])`), read as the caller; any `refuse` blocks the file, a `warn` waits for acceptance. */
	check?: (
		ctx: PipelineCtx,
		x: {
			input: InputOf<I>;
			records: readonly Rec[];
			rows: readonly (M | null)[];
			known: K;
		} & Context<X>
	) => BodyReturn<readonly ImportFinding[]>;
	/** The rows a downloaded template is prefilled with, by input field name, read as the caller. Default: the header row alone. */
	template?: (
		ctx: PipelineCtx,
		x: Context<X>
	) => BodyReturn<readonly { readonly [field: string]: TemplateCell }[]>;
} & (Keyed<C> extends true
	? { onConflict: 'update' | 'keep' }
	: { onConflict?: 'update' | 'keep' });
type PipelineSpec<C, I, Rec, M = Insert<C>, K = undefined, X = {}> = {
	import?: ImportSpec<C, I, Rec, M, K, X>;
	export?: {
		description: string;
		select: readonly ReadField<C>[];
		where?: Where<C>;
		format: 'csv' | 'xlsx' | 'json';
	};
};

/**
 * `src/data/collection/<c>/+pipeline.ts`: file import and export of collection `<c>`: an `import` maps a sheet's or file's
 * records onto inserts that enter through the collection's write pipeline as the caller (a JSON or xlsx upload, a
 * downloadable xlsx template, an optional `scope` set with deletes, `check` findings); an `export` writes the selected
 * fields as CSV, XLSX or JSON. The view toolbar's ⚡ menu wires every pipeline by itself.
 */
export function pipeline<
	const C extends ModelName,
	const I extends InputFields = {},
	Rec = never,
	M = Insert<C>,
	K = undefined,
	const X extends InputFields = {}
>(
	name: C,
	spec: PipelineSpec<C, I, Rec, M, K, X>
): { readonly name: C; readonly spec: PipelineSpec<C, I, Rec, M, K, X> } {
	// the ctx-bearing bodies attach here; records, map, related and scope.of are pure
	const i = spec.import;
	if (i?.known !== undefined) i.known = attached(i.known, 0);
	if (i?.check !== undefined) i.check = attached(i.check, 0);
	if (i?.template !== undefined) i.template = attached(i.template, 0);
	return { name, spec };
}
