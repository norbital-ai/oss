// Typed input decoding and reference discovery share std/kind's one codec.
import { inputSchema, type Fields, type Kind, type Value } from '@norbital-ai/std/kind';
import { Predicate, Result, Schema, SchemaIssue } from 'effect';
import type { Json } from '../../decl/values.ts';

export type InputSpec = Fields;
export type Decoded = {
	value: Value | undefined;
	problems: { path: string; message: string }[];
	refs: { collection: string; id: string; field: string }[];
};
const format = SchemaIssue.makeFormatterStandardSchemaV1({
	leafHook: (issue) => {
		if (issue._tag === 'MissingKey') return 'is required';
		if (issue._tag === 'UnexpectedKey') return 'is not an input';
		const message = SchemaIssue.defaultLeafHook(issue);
		return message
			.replace(/^Expected string$/, 'expected text')
			.replace(/^Expected number$/, 'expected a number')
			.replace(/^Expected boolean$/, 'expected true or false')
			.replace(/^Expected Array.*$/, 'expected a list')
			.replace(/^Expected object$/, 'expected an object');
	}
});
/** A keyed list's items (`{ kind: 'list', key }`) each carry a distinct, non-empty key; offenders by path. */
function keyProblems(kind: Kind, raw: unknown, at: string, out: Decoded['problems']): void {
	const join = (k: string) => (at ? `${at}.${k}` : k);
	switch (kind.kind) {
		case 'list': {
			if (!Array.isArray(raw)) return;
			const key = 'key' in kind && typeof kind.key === 'string' ? kind.key : undefined;
			const field =
				key !== undefined && kind.of.kind === 'object' ? kind.of.fields[key] : undefined;
			const seen = new Set<string>();
			raw.forEach((item, index) => {
				keyProblems(kind.of, item, join(String(index)), out);
				if (key === undefined || !Predicate.isObject(item)) return;
				const v = item[key];
				const text =
					typeof v === 'number' ? String(v) : typeof v === 'string' && v !== '' ? v : undefined;
				// an absent required key is already the codec's `is required`
				if (text === undefined) {
					if (v !== undefined || field === undefined || field.optional === true)
						out.push({ path: join(`${index}.${key}`), message: 'is required: it keys the list' });
				} else if (seen.has(text))
					out.push({ path: join(`${index}.${key}`), message: `repeats the key '${text}'` });
				else seen.add(text);
			});
			return;
		}
		case 'record':
			if (Predicate.isObject(raw))
				for (const [key, item] of Object.entries(raw)) keyProblems(kind.of, item, join(key), out);
			return;
		case 'object':
			if (Predicate.isObject(raw))
				for (const [key, item] of Object.entries(raw)) {
					const child = kind.fields[key] ?? kind.rest;
					if (child !== undefined) keyProblems(child, item, join(key), out);
				}
			return;
		case 'json':
			if (kind.shape !== undefined) keyProblems(kind.shape, raw, at, out);
			return;
		case 'union': {
			if ('of' in kind || !Predicate.isObject(raw)) return;
			const tag = raw[kind.by];
			const fields = typeof tag === 'string' ? kind.arms[tag] : undefined;
			if (fields !== undefined) keyProblems({ kind: 'object', fields }, raw, at, out);
			return;
		}
		default:
			return;
	}
}
/** Every offender at once, including excess keys; callers pass the decoded value onward. */
export function decodeInput(spec: InputSpec | undefined, input: Json | undefined): Decoded {
	const codec = inputSchema({ kind: 'object', fields: spec ?? {} });
	const result = Schema.decodeUnknownResult(codec, { errors: 'all', onExcessProperty: 'error' })(
		input ?? {}
	);
	const keyed: Decoded['problems'] = [];
	keyProblems({ kind: 'object', fields: spec ?? {} }, input ?? {}, '', keyed);

	const refs: Decoded['refs'] = [];
	function visit(kind: Kind, value: Value, at: string, scalar = false): void {
		if (value === null) return;
		if (!scalar && 'many' in kind && kind.many === true && Array.isArray(value)) {
			value.forEach((item, index) => visit(kind, item, `${at}.${index}`, true));
			return;
		}
		switch (kind.kind) {
			case 'id':
				if (typeof value === 'string') refs.push({ collection: kind.of, id: value, field: at });
				return;
			case 'list':
				if (Array.isArray(value))
					value.forEach((item, index) => visit(kind.of, item, `${at}.${index}`));
				return;
			case 'record':
				if (Predicate.isObject(value))
					for (const [key, item] of Object.entries(value))
						visit(kind.of, item, at ? `${at}.${key}` : key);
				return;
			case 'object':
				if (Predicate.isObject(value))
					for (const [key, child] of Object.entries(kind.fields)) {
						const item = value[key];
						if (item !== undefined) visit(child, item, at ? `${at}.${key}` : key);
					}
				return;
			case 'union': {
				if ('of' in kind) {
					for (const arm of kind.of)
						if (Result.isSuccess(Schema.decodeUnknownResult(inputSchema(arm))(value))) {
							visit(arm, value, at);
							break;
						}
				} else if (Predicate.isObject(value)) {
					const tag = value[kind.by];
					const fields = typeof tag === 'string' ? kind.arms[tag] : undefined;
					if (fields !== undefined) visit({ kind: 'object', fields }, value, at);
				}
				return;
			}
			default:
				return;
		}
	}
	if (Result.isFailure(result)) {
		function valid(kind: Kind, raw: unknown, at: string): void {
			const decoded = Schema.decodeUnknownResult(inputSchema(kind), {
				errors: 'all',
				onExcessProperty: 'error'
			})(raw);
			if (Result.isSuccess(decoded)) {
				visit(kind, decoded.success, at);
				return;
			}
			if (kind.kind === 'list' && Array.isArray(raw))
				raw.forEach((item, index) => valid(kind.of, item, `${at}.${index}`));
			else if (kind.kind === 'record' && Predicate.isObject(raw))
				for (const [key, item] of Object.entries(raw)) valid(kind.of, item, `${at}.${key}`);
			else if (kind.kind === 'object' && Predicate.isObject(raw)) {
				for (const [key, child] of Object.entries(kind.fields))
					if (raw[key] !== undefined) valid(child, raw[key], at ? `${at}.${key}` : key);
			} else if (kind.kind === 'union' && 'arms' in kind && Predicate.isObject(raw)) {
				const tag = raw[kind.by];
				const fields = typeof tag === 'string' ? kind.arms[tag] : undefined;
				if (fields !== undefined) valid({ kind: 'object', fields }, raw, at);
			}
		}
		valid({ kind: 'object', fields: spec ?? {} }, input ?? {}, '');
		const fields = Object.keys(spec ?? {});
		const problems = [
			...format(result.failure.issue).issues.map((issue) => ({
				path: issue.path?.map(String).join('.') || 'input',
				message: issue.message
			})),
			...keyed
		];
		problems.sort(
			(a, b) =>
				fields.indexOf(a.path.split('.')[0] ?? '') - fields.indexOf(b.path.split('.')[0] ?? '')
		);
		return { value: undefined, refs, problems };
	}
	if (keyed.length > 0) return { value: undefined, refs, problems: keyed };
	visit({ kind: 'object', fields: spec ?? {} }, result.success, '');
	return { value: result.success, problems: [], refs };
}
