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
/** Every offender at once, including excess keys; callers pass the decoded value onward. */
export function decodeInput(spec: InputSpec | undefined, input: Json | undefined): Decoded {
	const codec = inputSchema({ kind: 'object', fields: spec ?? {} });
	const result = Schema.decodeUnknownResult(codec, { errors: 'all', onExcessProperty: 'error' })(
		input ?? {}
	);

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
		const problems = format(result.failure.issue).issues.map((issue) => ({
			path: issue.path?.map(String).join('.') || 'input',
			message: issue.message
		}));
		problems.sort(
			(a, b) =>
				fields.indexOf(a.path.split('.')[0] ?? '') - fields.indexOf(b.path.split('.')[0] ?? '')
		);
		return { value: undefined, refs, problems };
	}
	visit({ kind: 'object', fields: spec ?? {} }, result.success, '');
	return { value: result.success, problems: [], refs };
}
