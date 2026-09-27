// Decoding a typed input (§3.3.2 input kinds): the `input` of a collection query, action or automation start. Every
// offender at once (rule 23), excess keys refused (rule 5), and the `id` refs it names collected for rule 36.
import type { Json } from '../../decl/values.ts';

type Kind = { readonly kind: string; readonly optional?: true; readonly default?: unknown; readonly [k: string]: unknown };
export type InputSpec = { readonly [name: string]: Kind };
export type Decoded = { problems: { path: string; message: string }[]; refs: { collection: string; id: string; field: string }[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v: unknown): v is { readonly [k: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);
const decimal = (v: Json) => typeof v === 'number' ? Number.isFinite(v) : /^-?\d+(\.\d+)?$/.test(String(isObj(v) ? v['$dec'] : v));

/** `input` against `spec`; `null`/`undefined` is an empty object. */
export function decodeInput(spec: InputSpec | undefined, input: Json | undefined): Decoded {
	const out: Decoded = { problems: [], refs: [] };
	fields(spec ?? {}, input ?? {}, '', out);
	return out;
}

function fields(spec: InputSpec, v: Json, at: string, out: Decoded): void {
	if (!isObj(v)) { out.problems.push({ path: at || 'input', message: 'expected an object' }); return; }
	for (const k of Object.keys(v)) if (!Object.hasOwn(spec, k)) out.problems.push({ path: join(at, k), message: 'is not an input' });
	for (const [k, kind] of Object.entries(spec)) {
		const x = v[k];
		if (x === undefined || x === null) {
			if (kind.optional !== true && kind.default === undefined) out.problems.push({ path: join(at, k), message: 'is required' });
			continue;
		}
		value(kind, x, join(at, k), out);
	}
}

function value(k: Kind, v: Json, at: string, out: Decoded): void {
	const bad = (message: string) => void out.problems.push({ path: at, message });
	const num = (n: number) => (k.min !== undefined && n < Number(k.min)) || (k.max !== undefined && n > Number(k.max)) ? bad(`is out of range`) : undefined;
	switch (k.kind) {
		case 'text': return typeof v !== 'string' ? bad('expected text') : k.max !== undefined && v.length > Number(k.max) ? bad(`is over ${String(k.max)} characters`)
			: k.format === 'email' && !/^[^@\s]+@[^@\s]+$/.test(v) ? bad('expected an email address') : undefined;
		case 'int': return typeof v !== 'number' || !Number.isInteger(v) ? bad('expected an integer') : num(v);
		case 'number': return typeof v !== 'number' || !Number.isFinite(v) ? bad('expected a number') : num(v);
		case 'decimal': case 'money': return decimal(v) ? undefined : bad('expected a decimal');
		case 'bool': return typeof v === 'boolean' ? undefined : bad('expected true or false');
		case 'date': return typeof v === 'string' && DATE.test(v) ? undefined : bad('expected a date (YYYY-MM-DD)');
		case 'instant': return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? undefined : bad('expected an instant');
		case 'enum': return (k.values as readonly string[]).includes(String(v)) ? undefined : bad(`expected one of ${(k.values as readonly string[]).join(', ')}`);
		case 'id':
			if (typeof v !== 'string' || !UUID.test(v)) return bad('expected an id');
			out.refs.push({ collection: String(k.of), id: v, field: at });
			return;
		case 'list':
			if (!Array.isArray(v)) return bad('expected a list');
			if ((k.min !== undefined && v.length < Number(k.min)) || (k.max !== undefined && v.length > Number(k.max))) bad('has the wrong number of items');
			return v.forEach((x, i) => value(k.of as Kind, x, `${at}.${i}`, out));
		case 'object': return fields(k.fields as InputSpec, v, at, out);
		case 'record':
			if (!isObj(v)) return bad('expected an object');
			return Object.entries(v).forEach(([key, x]) => value(k.of as Kind, x, join(at, key), out));
		case 'union': {
			// untagged (`of`): the first arm the value decodes against, by kind
			if (Array.isArray(k.of)) {
				for (const arm of k.of as readonly Kind[]) {
					const d: Decoded = { problems: [], refs: [] };
					value(arm, v, at, d);
					if (d.problems.length === 0) return void out.refs.push(...d.refs);
				}
				return bad(`expected one of ${(k.of as readonly Kind[]).map((a) => a.kind).join(', ')}`);
			}
			const arms = k.arms as { readonly [tag: string]: InputSpec };
			const tag = isObj(v) ? v[String(k.by)] : undefined;
			if (typeof tag !== 'string' || !Object.hasOwn(arms, tag)) return bad(`expected ${String(k.by)} to be one of ${Object.keys(arms).join(', ')}`);
			const { [String(k.by)]: _, ...rest } = v as { readonly [key: string]: Json };
			return fields(arms[tag]!, rest, at, out);
		}
		case 'vector': return Array.isArray(v) && v.length === Number(k.dim) && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? undefined : bad(`expected ${String(k.dim)} numbers`);
		// ponytail: json, file, point, period, time, duration and custom pass as given; the consuming body checks them
		default: return undefined;
	}
}
const join = (at: string, k: string) => at === '' ? k : `${at}.${k}`;
