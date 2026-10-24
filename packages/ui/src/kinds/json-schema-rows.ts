/**
 * A JSON Schema as the flat field list its matrix shows and edits, and back. A row's `path` names a property by
 * its dotted path (`facts.gender`); `[]` steps into an array's items (`contract_terms[].grade`, or `tags[]` for a
 * list's own item type). A row edits its type, label (`title`), help (`description`), whether it is required and its
 * enum values; every other keyword (format, bounds, default, const, conditionals, `additionalProperties`) is carried
 * from the node the row was read from. Rows nest under their parents however they are ordered.
 */
import { Option, Schema } from 'effect';

type Json = Schema.Json;
type JsonObject = { readonly [key: string]: Json };
const isJsonObject: (value: unknown) => value is JsonObject = Schema.is(
	Schema.Record(Schema.String, Schema.Json)
);

export const FIELD_TYPES = [
	'string',
	'date',
	'number',
	'integer',
	'boolean',
	'object',
	'array'
] as const;
type FieldType = (typeof FIELD_TYPES)[number];
/** One property of a schema as its matrix row: `path` dotted, `[]` stepping into a list's items. */
export type JsonSchemaRow = {
	readonly path: string;
	readonly type: FieldType;
	readonly label: string;
	readonly help: string;
	readonly required: boolean;
	readonly values: string;
};

const ITEMS = '[]';
const isString = Schema.is(Schema.String);
const toNumber = Schema.decodeUnknownOption(Schema.NumberFromString);
const strings = (value: unknown): readonly string[] =>
	Array.isArray(value) ? value.filter(isString) : [];
const textOf = (value: unknown) => (isString(value) ? value : '');
const fieldType = (value: unknown): FieldType | undefined =>
	FIELD_TYPES.find((type) => type === value);

/** A node's field type: `date` is a string of `format: date`; an untyped node reads by its keywords. */
const typeOf = (node: JsonObject): FieldType => {
	const type = Array.isArray(node.type) ? node.type.find((held) => held !== 'null') : node.type;
	if (type === 'string' && node.format === 'date') return 'date';
	return (
		fieldType(type) ??
		(isJsonObject(node.properties) ? 'object' : node.items !== undefined ? 'array' : 'string')
	);
};

type Read = {
	readonly rows: JsonSchemaRow[];
	readonly nodes: JsonObject[];
	readonly at: Map<string, JsonObject>;
};

/** Every property under `node`, depth first, each row beside the node it was read from. */
function read(node: JsonObject, prefix: string, out: Read): void {
	const properties = isJsonObject(node.properties) ? node.properties : {};
	const required = strings(node.required);
	for (const [key, entry] of Object.entries(properties)) {
		const child = isJsonObject(entry) ? entry : {};
		const path = `${prefix}${key}`;
		out.rows.push(rowOf(path, child, required.includes(key)));
		out.nodes.push(child);
		out.at.set(path, child);
		descend(child, path, out);
	}
}
function descend(node: JsonObject, path: string, out: Read): void {
	const type = typeOf(node);
	if (type === 'object') read(node, `${path}.`, out);
	if (type !== 'array' || !isJsonObject(node.items)) return;
	const items = node.items;
	out.at.set(`${path}${ITEMS}`, items);
	if (typeOf(items) === 'object') return read(items, `${path}${ITEMS}.`, out);
	out.rows.push(rowOf(`${path}${ITEMS}`, items, false));
	out.nodes.push(items);
}
const rowOf = (path: string, node: JsonObject, required: boolean): JsonSchemaRow => ({
	path,
	type: typeOf(node),
	label: textOf(node.title),
	help: textOf(node.description),
	required,
	values: Array.isArray(node.enum) ? node.enum.map(String).join(', ') : ''
});
function readSchema(schema: unknown): Read {
	const root = isJsonObject(schema) ? schema : { type: 'object' };
	const out: Read = { rows: [], nodes: [], at: new Map([['', root]]) };
	read(root, '', out);
	return out;
}

/** The field list a stored schema reads as: the matrix's rows. */
export function jsonSchemaRows(schema: unknown): readonly JsonSchemaRow[] {
	return readSchema(schema).rows;
}

const rowFrom = (entry: unknown): JsonSchemaRow => {
	const held = isJsonObject(entry) ? entry : {};
	return {
		path: textOf(held.path),
		type: fieldType(held.type) ?? 'string',
		label: textOf(held.label),
		help: textOf(held.help),
		required: held.required === true,
		values: textOf(held.values)
	};
};
const stepsOf = (path: string): string[] =>
	path.split('.').flatMap((segment) => {
		let name = segment.trim();
		let items = 0;
		while (name.endsWith(ITEMS)) {
			name = name.slice(0, -ITEMS.length);
			items += 1;
		}
		return [...(name === '' ? [] : [name]), ...Array.from({ length: items }, () => ITEMS)];
	});
const joined = (steps: readonly string[]) =>
	steps.reduce(
		(path, step) => (step === ITEMS || path === '' ? `${path}${step}` : `${path}.${step}`),
		''
	);

type Tree = {
	base: JsonObject;
	row?: JsonSchemaRow;
	readonly required: string[];
	readonly properties: Map<string, Tree>;
	items?: Tree;
};
const tree = (base: JsonObject): Tree => ({ base, required: [], properties: new Map() });

const SHAPED = [
	'type',
	'format',
	'title',
	'description',
	'enum',
	'properties',
	'items',
	'required'
];
function write(at: Tree): JsonObject {
	const { base, row } = at;
	const kind = row?.type ?? (at.properties.size > 0 ? 'object' : at.items ? 'array' : typeOf(base));
	const out: { [keyword: string]: Json } = Object.fromEntries(
		Object.entries(base).filter(([keyword]) => !SHAPED.includes(keyword))
	);
	const same = typeOf(base) === kind;
	if (same && base.type !== undefined) out.type = base.type;
	if (same && base.format !== undefined) out.format = base.format;
	if (!same || base.type === undefined) out.type = kind === 'date' ? 'string' : kind;
	if (kind === 'date') out.format = 'date';
	const label = row ? row.label.trim() : textOf(base.title);
	const help = row ? row.help.trim() : textOf(base.description);
	if (label !== '') out.title = label;
	if (help !== '') out.description = help;
	const values = row
		? row.values
				.split(',')
				.map((part) => part.trim())
				.filter((part) => part !== '')
		: [];
	const numeric = kind === 'number' || kind === 'integer';
	if (row && values.length > 0 && (numeric || kind === 'string' || kind === 'date'))
		out.enum = values.map((part) =>
			numeric ? Option.getOrElse(toNumber(part), () => part) : part
		);
	else if (!row && Array.isArray(base.enum)) out.enum = base.enum;
	if (kind === 'object') {
		out.properties = Object.fromEntries(
			[...at.properties].map(([key, child]) => [key, write(child)])
		);
		// the order the schema held them in, then the newly required
		const held = strings(base.required);
		const rank = (key: string) => (held.includes(key) ? held.indexOf(key) : held.length);
		if (at.required.length > 0) out.required = [...at.required].sort((a, b) => rank(a) - rank(b));
	}
	if (kind === 'array')
		out.items = write(at.items ?? tree(isJsonObject(base.items) ? base.items : {}));
	return out;
}

/**
 * The schema an edited field list writes, over the schema it was read from (`held`). Blank and repeated paths are
 * made unique; a list of the same length is the same fields in place, so a renamed row keeps its other keywords and
 * its children follow it.
 */
export function jsonSchemaFromRows(next: unknown, held: unknown): JsonObject {
	const prev = readSchema(held);
	const rows = Array.isArray(next) ? next.map(rowFrom) : [];
	const inPlace = rows.length === prev.rows.length;
	let paths = rows.map((row) => joined(stepsOf(row.path)));
	if (inPlace)
		prev.rows.forEach((was, index) => {
			const now = paths[index];
			if (now === undefined || now === '' || now === was.path) return;
			paths = paths.map((path, other) =>
				other !== index &&
				(path.startsWith(`${was.path}.`) || path.startsWith(`${was.path}${ITEMS}`))
					? `${now}${path.slice(was.path.length)}`
					: path
			);
		});
	const taken = new Set<string>();
	const unique = paths.map((path, index) => {
		let name = path === '' ? `field_${index + 1}` : path;
		for (let suffix = 2; taken.has(name); suffix += 1) name = `${path || 'field'}_${suffix}`;
		taken.add(name);
		return name;
	});
	const root = tree(prev.at.get('') ?? { type: 'object' });
	rows.forEach((row, index) => {
		const path = unique[index] ?? '';
		const steps = stepsOf(path);
		let at = root;
		let parent = root;
		steps.forEach((step, depth) => {
			const base = prev.at.get(joined(steps.slice(0, depth + 1))) ?? {};
			parent = at;
			if (step === ITEMS) at = at.items ??= tree(base);
			else {
				const child = at.properties.get(step) ?? tree(base);
				at.properties.set(step, child);
				at = child;
			}
		});
		at.base = (inPlace ? prev.nodes[index] : prev.at.get(path)) ?? at.base;
		at.row = { ...row, path };
		const key = steps.at(-1);
		if (row.required && key !== undefined && key !== ITEMS) parent.required.push(key);
	});
	return write(root);
}
