import { KIND, type Kind, type FieldKind } from '@norbital-ai/std/kind';

type Editor =
	| 'typed'
	| 'tags'
	| 'zone'
	| 'code'
	| 'markdown'
	| 'textarea'
	| 'bool'
	| 'currency'
	| 'time'
	| 'period'
	| 'enum'
	| 'enumMany'
	| 'id'
	| 'schema'
	| 'json'
	| 'show';
type Presentation = {
	readonly editor: Editor;
	readonly derived: boolean;
	readonly numeric: boolean;
	readonly sortable: boolean;
};
const entry = (kind: FieldKind, editor: Editor, derived = false): Presentation => ({
	editor,
	derived,
	numeric: KIND[kind].traits.numeric,
	sortable: KIND[kind].traits.sortable
});

/** Presentation decisions share the canonical kind traits. */
export const KINDS = {
	text: entry('text', 'typed'),
	int: entry('int', 'typed'),
	number: entry('number', 'typed'),
	decimal: entry('decimal', 'typed'),
	money: entry('money', 'typed'),
	duration: entry('duration', 'typed'),
	currency: entry('currency', 'currency'),
	bool: entry('bool', 'bool'),
	date: entry('date', 'time'),
	instant: entry('instant', 'time'),
	time: entry('time', 'time'),
	period: entry('period', 'period'),
	enum: entry('enum', 'enum'),
	state: entry('state', 'show', true),
	seq: entry('seq', 'show', true),
	sum: entry('sum', 'show', true),
	count: entry('count', 'show', true),
	vector: entry('vector', 'show', true),
	id: entry('id', 'id'),
	json: entry('json', 'json'),
	custom: entry('custom', 'json'),
	file: entry('file', 'show'),
	point: entry('point', 'show'),
	object: entry('object', 'schema'),
	list: entry('list', 'schema'),
	union: entry('union', 'schema'),
	record: entry('record', 'schema')
} satisfies { readonly [K in FieldKind]: Presentation };

/** Select the editor for a declared kind, including text formats, many-valued enums and shaped JSON, while retaining canonical numeric, sortable and derived traits. */
export function presentation(kind: Kind): Presentation {
	const base = KINDS[kind.kind];
	if (kind.kind === 'text') {
		const editor = kind.many
			? 'tags'
			: kind.format === 'zone'
				? 'zone'
				: kind.format === 'cel'
					? 'code'
					: kind.format === 'markdown'
						? 'markdown'
						: (kind.max ?? 0) > 200
							? 'textarea'
							: 'typed';
		return { ...base, editor };
	}
	if (kind.kind === 'enum' && kind.many) return { ...base, editor: 'enumMany' };
	if (kind.kind === 'json' && kind.shape !== undefined) return { ...base, editor: 'schema' };
	return base;
}

/** Lists and many-valued fields have no scalar ordering. */
export const sortable = (kind: Kind): boolean =>
	KINDS[kind.kind].sortable &&
	!('many' in kind && kind.many === true) &&
	!('multiple' in kind && kind.multiple === true);
