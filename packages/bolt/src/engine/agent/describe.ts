// `describe` (act and read): one callable's exact input, or one read key's row, as compact TypeScript rendered from the
// manifest the engine decodes writes and reads by — the same kinds `decodeValue` accepts — narrowed to the caller's
// policy columns and fields. Asked on demand, so no type rides the prompt.
import { Predicate } from 'effect';
import { SYSTEM_COLUMNS } from '@norbital-ai/store';
import { exposed } from '../access/authority.ts';
import type { Authority } from '../contracts.ts';
import { layered, layers, type EngineManifest } from '../manifest.ts';

const at = (v: unknown, key: string): unknown => (Predicate.isObject(v) ? v[key] : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const entries = (v: unknown): [string, unknown][] =>
	Predicate.isObject(v) ? Object.entries(v) : [];

/** What the aliases the types use mean; only those a description uses are listed. */
const ALIASES: { readonly [alias: string]: string } = {
	'Id<': 'Id<m> = a relationship: the id (a string) of the m row it links to',
	Date: 'Date = "YYYY-MM-DD"',
	Instant: 'Instant = an ISO 8601 date-time',
	Decimal: 'Decimal = a number or decimal text',
	File: 'File = { id, name, mime } as a message or tool lists it',
	Point: 'Point = { lat: number; lng: number }'
};
const legend = (types: string) =>
	Object.entries(ALIASES)
		.filter(([alias]) => new RegExp(`\\b${alias}`).test(types))
		.map(([, means]) => means)
		.join('; ');

/** One value kind (a field, or a kind inside a custom or list shape) as TypeScript. */
function typeOf(m: EngineManifest, k: unknown): string {
	const one = (): string => {
		switch (text(at(k, 'kind'))) {
			case 'text':
			case 'currency':
			case 'seq':
			case 'id':
				return 'string';
			case 'enum':
				return list(at(k, 'values'))
					.map((v) => JSON.stringify(v))
					.join(' | ');
			case 'state':
				return entries(at(k, 'states'))
					.map(([s]) => JSON.stringify(s))
					.join(' | ');
			case 'int':
			case 'number':
			case 'duration':
			case 'count':
				return 'number';
			case 'decimal':
			case 'money':
			case 'sum':
				return 'Decimal';
			case 'bool':
				return 'boolean';
			case 'date':
				return 'Date';
			case 'instant':
				return 'Instant';
			case 'file':
				return 'File';
			case 'point':
				return 'Point';
			case 'vector':
				return 'number[]';
			case 'period':
				return at(k, 'of') === 'date'
					? '{ from: Date; to: Date | null }'
					: '{ start: Instant; end: Instant | null }';
			case 'ref':
				return `{ model: ${
					list(at(k, 'to'))
						.map((v) => JSON.stringify(v))
						.join(' | ') || 'string'
				}; id: string }`;
			case 'list':
				return `Array<${typeOf(m, at(k, 'of'))}>`;
			case 'record':
				return `{ [key: string]: ${typeOf(m, at(k, 'of'))} }`;
			case 'object':
				return shape(m, at(k, 'fields'));
			case 'union': {
				const of = at(k, 'of');
				if (of !== undefined)
					return list(of)
						.map((x) => typeOf(m, x))
						.join(' | ');
				const by = text(at(k, 'by')) ?? 'kind';
				return entries(at(k, 'arms'))
					.map(([tag, fields]) => shape(m, fields, `${by}: ${JSON.stringify(tag)}`))
					.join(' | ');
			}
			case 'custom': {
				const of = text(at(k, 'of'));
				return of === undefined ? 'unknown' : typeOf(m, at(m.customFields[of], 'shape'));
			}
			default:
				return 'unknown';
		}
	};
	const t = one();
	return at(k, 'many') === true ? `Array<${t}>` : t;
}
/** An object's fields as `{ a: T; b?: T }`, a union arm's tag first. */
const shape = (m: EngineManifest, fields: unknown, tag?: string): string => {
	const parts = [
		...(tag === undefined ? [] : [tag]),
		...entries(fields).map(
			([f, k]) => `${f}${at(k, 'optional') === true ? '?' : ''}: ${typeOf(m, k)}`
		)
	];
	return parts.length === 0 ? '{}' : `{ ${parts.join('; ')} }`;
};
/** A column of `model`: a relationship's key is the id of its target, otherwise its field's kind. */
const columnType = (m: EngineManifest, model: string, f: string): string => {
	const r = m.relationships[`${model}.${f}`];
	if (r !== undefined) return `Id<${typeof r.to === 'string' ? r.to : r.to.join(' | ')}>`;
	if (SYSTEM_COLUMNS.some((c) => c === f))
		return f === 'id' ? `Id<${model}>` : f.endsWith('_at') ? 'Instant' : 'string';
	return typeOf(m, layered(m).models[model]?.fields[f]);
};

type Verb = 'create' | 'update' | 'delete' | 'upsert';
/**
 * `<model>.<verb>`'s exact input for `a`: every layer's columns its policies let it write (all for an administrator), a
 * create marking what it may omit (`col?`: optional, defaulted, or filled by the model's transform). Related layers nest
 * in their parent row: an array of rows (or ids to link) on create, `{ create, update, delete, link, unlink }` on update.
 */
export function describeWrite(m: EngineManifest, a: Authority, model: string, verb: Verb): string {
	const spec = m.exposures[model];
	const write = verb === 'upsert' || verb === 'create' ? spec?.create : spec?.update;
	if (verb === 'delete') return `Array<{ target: Id<${model}> }>\n${legend('Id<')}`;
	if (write === undefined) return `${model} declares no ${verb}`;
	const filled = verb === 'update' ? undefined : spec?.create?.filled;
	const arms = a.models[model]?.[verb === 'update' ? 'update' : 'create'] ?? [];
	const allowed = (path: string) => {
		const declared = write.columns[path] ?? [];
		return a.admin
			? declared
			: declared.filter((f) => arms.some((arm) => arm.columns[path]?.includes(f)));
	};
	const behind = layers(m)[model] ?? {};
	const children = (path: string) =>
		Object.keys(write.columns).filter(
			(p) => p.lastIndexOf('.') === path.length && p.startsWith(`${path}.`)
		);
	const row = (path: string, create: boolean): string => {
		const target = behind[path] ?? model;
		const cols = allowed(path).map((f) => {
			const d = m.models[target]?.fields[f];
			const r = m.relationships[`${target}.${f}`];
			const optional =
				!create ||
				d?.optional === true ||
				d?.default !== undefined ||
				r?.optional === true ||
				filled?.[path]?.includes(f) === true;
			return `${f}${optional ? '?' : ''}: ${columnType(m, target, f)}`;
		});
		const rels = children(path).map((child) => {
			const rel = child.slice(path.length + 1),
				of = behind[child] ?? rel;
			return create
				? `${rel}?: Array<${row(child, true)} | Id<${of}>>`
				: `${rel}?: { create?: Array<${row(child, true)}>; update?: Array<{ target: Id<${of}>; set: ${row(child, false)} }>; delete?: Array<Id<${of}>>; link?: Array<Id<${of}>>; unlink?: Array<Id<${of}>> }`;
		});
		return `{ ${[...cols, ...rels].join('; ')} }`;
	};
	const input =
		verb === 'create'
			? `Array<${row(model, true)}>`
			: verb === 'upsert'
				? `Array<{ id?: Id<${model}> } & ${row(model, true)}>`
				: `Array<{ target: Id<${model}>; set: ${row(model, false)} }>`;
	return `${input}\n${legend(input)}`;
}

/** What one read key gives `a`: the fields its declaration exposes that some read arm at that path admits, and whether
 * `search` works there (every field the search covers exposed and unmasked, rule 14). */
export function keyShape(
	m: EngineManifest,
	a: Authority,
	path: string
): { fields: readonly string[]; search: boolean } {
	const root = path.split('.')[0]!;
	const model = layers(m)[root]?.[path] ?? root;
	const exposedHere = exposed(m, root, path, model);
	const arms = a.models[root]?.read[path] ?? [];
	const open = a.admin || arms.length === 0 || arms.some((x) => x.fields === 'all');
	const admitted = open
		? exposedHere
		: exposedHere.filter((f) => arms.some((x) => x.fields !== 'all' && x.fields.includes(f)));
	const masked = a.models[root]?.masks[path] ?? {};
	const searched = layered(m).models[model]?.search?.text ?? [];
	return {
		// the audit columns beside id and its times say little to an agent; the rest are its declared fields
		fields: [...new Set(['id', 'created_at', 'updated_at', ...admitted])],
		search: searched.length > 0 && searched.every((f) => exposedHere.includes(f) && !(f in masked))
	};
}

/**
 * One read key's row as `a` reads it: each field it may see with its type (the same fields where, orderBy and aggregate
 * take), and each layer below it among `paths` nested by its relation name — one object (or null) where the row holds
 * the link, else an array.
 */
export function describeRead(
	m: EngineManifest,
	a: Authority,
	path: string,
	paths: readonly string[]
): string {
	const root = path.split('.')[0]!,
		behind = layers(m)[root] ?? {};
	const row = (p: string): string => {
		const model = behind[p] ?? root;
		const cols = keyShape(m, a, p).fields.map((f) => `${f}: ${columnType(m, model, f)}`);
		const nested = paths
			.filter((q) => q.lastIndexOf('.') === p.length && q.startsWith(`${p}.`))
			.map((q) => {
				const rel = q.slice(p.length + 1);
				return m.relationships[`${model}.${rel}`] === undefined
					? `${rel}: Array<${row(q)}> /* with "${q}" */`
					: `${rel}: ${row(q)} | null /* with "${q}", in place of its id */`;
			});
		return `{ ${[...cols, ...nested].join('; ')} }`;
	};
	const shapeOf = row(path),
		{ search } = keyShape(m, a, path);
	return (
		`${path} row: ${shapeOf}\n` +
		`Any field may be null. where, orderBy and aggregate take these fields (a layer's own, never its link); search: ${search ? 'yes' : 'no, use where'}.\n` +
		legend(shapeOf)
	);
}
