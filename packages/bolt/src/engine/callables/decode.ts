// Typed input decoding and reference discovery share std/kind's one codec.
import {
	input_schema,
	type Fields,
	type Kind,
	type Value,
	type Where
} from '@norbital-ai/std/kind';
import { Array as EffectArray, Effect, Predicate, Result, Schema, SchemaIssue } from 'effect';
import type { Json } from '../../decl/values.ts';
import { encode_wire } from '@norbital-ai/std/wire';
import { automation_fields, type AutomationInputSchema } from '../../decl/runtime/automation-input.ts';
import { BoltError } from '../../protocol/errors.ts';
import { LIMITS } from '../contracts.ts';
import { customShape, kindChildren } from './kinds.ts';

export type InputSpec = Fields;
export type Decoded = {
	value: Value | undefined;
	problems: { path: string; message: string }[];
	refs: { model: string; id: string; field: string; where?: Where }[];
	custom?: readonly { name: string; value: Json; path: string }[];
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
/** A many-valued object's items each carry a distinct, non-empty key; offenders by path. */
function keyProblems(kind: Kind, raw: unknown, at: string, out: Decoded['problems']): void {
	const join = (k: string) => (at ? `${at}.${k}` : k);
	if (kind.many === true) {
		if (!EffectArray.isArray(raw)) return;
		const key = 'key' in kind && typeof kind.key === 'string' ? kind.key : undefined;
		const field = key !== undefined && kind.kind === 'object' ? kind.fields[key] : undefined;
		const seen = new Set<string>();
		const children = kindChildren(kind, raw, at, { raw: true });
		raw.forEach((item, index) => {
			const child = children[index];
			if (child !== undefined) keyProblems(child.kind, child.value, child.path, out);
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
	if (kind.kind === 'custom') return;
	for (const child of kindChildren(kind, raw, at, { raw: true }))
		keyProblems(child.kind, child.value, child.path, out);
}
/** Every offender at once, including excess keys; callers pass the decoded value onward. */
export function decodeInput(
	spec: InputSpec | undefined,
	input: Json | undefined,
	custom_fields?: import('../manifest.ts').EngineManifest['custom_fields']
): Decoded {
	const original = spec ?? {};
	const declarations: Decoded['problems'] = [];
	const shapeOf = (name: string) => customShape(custom_fields, name);
	const expand = (kind: Kind, path: string, seen: ReadonlySet<string>): Kind => {
		const fields = (input: InputSpec) =>
			Object.fromEntries(
				Object.entries(input).map(([name, child]) => [
					name,
					expand(child, path ? `${path}.${name}` : name, seen)
				])
			);
		switch (kind.kind) {
			case 'custom': {
				const shape = shapeOf(kind.of);
				if (shape === undefined || seen.has(kind.of)) {
					declarations.push({
						path,
						message:
							shape === undefined
								? `Unknown custom field '${kind.of}'.`
								: `Recursive custom field '${kind.of}'.`
					});
					return kind;
				}
				const resolvedShape = expand(shape, path, new Set([...seen, kind.of]));
				const resolved: Kind =
					kind.many === true ? { ...resolvedShape, many: true } : resolvedShape;
				const { optional: _optional, default: _default, ...body } = resolved;
				const { kind: _kind, of: _of, many: _many, ...common } = kind;
				return { ...body, ...common };
			}
			case 'record':
				return { ...kind, of: expand(kind.of, path, seen) };
			case 'object':
				return {
					...kind,
					fields: fields(kind.fields),
					...(kind.rest === undefined ? {} : { rest: expand(kind.rest, path, seen) })
				};
			case 'json':
				return kind.shape === undefined ? kind : { ...kind, shape: expand(kind.shape, path, seen) };
			case 'union':
				// Untagged arms are scalars: nothing to expand.
				return 'of' in kind
					? kind
					: {
							...kind,
							arms: Object.fromEntries(
								Object.entries(kind.arms).map(([tag, arm]) => [tag, fields(arm)])
							)
						};
			default:
				return kind;
		}
	};
	if (custom_fields !== undefined) {
		spec = Object.fromEntries(
			Object.entries(original).map(([name, kind]) => [name, expand(kind, name, new Set())])
		);
		if (declarations.length > 0) return { value: undefined, problems: declarations, refs: [] };
	}
	const codec = input_schema({ kind: 'object', fields: spec ?? {} });
	const result = Schema.decodeUnknownResult(codec, { errors: 'all', onExcessProperty: 'error' })(
		input ?? {}
	);
	const keyed: Decoded['problems'] = [];
	keyProblems({ kind: 'object', fields: spec ?? {} }, input ?? {}, '', keyed);

	const refs: Decoded['refs'] = [];
	const custom: NonNullable<Decoded['custom']>[number][] = [];
	const traversal = {
		...(custom_fields === undefined ? {} : { custom_fields }),
		union: (arms: readonly Kind[], value: unknown, path: string): Kind | undefined =>
			arms.find((arm) => Result.isSuccess(Schema.decodeUnknownResult(
				input_schema(custom_fields === undefined ? arm : expand(arm, path, new Set()))
			)(value)))
	};
	function visit(kind: Kind, value: Value, at: string): void {
		if (value === null) return;
		if (kind.many !== true && kind.kind === 'custom') {
			if (custom_fields === undefined) return;
			if (custom_fields[kind.of]?.check === true)
				custom.push({ name: kind.of, value: encode_wire(value), path: at });
		}
		if (kind.many !== true && kind.kind === 'ref') {
			const model = typeof kind.to === 'string' ? kind.to : Predicate.isObject(value) &&
				typeof value.model === 'string' && kind.to.includes(value.model) ? value.model : undefined;
			const id = typeof value === 'string' ? value : Predicate.isObject(value) && typeof value.id === 'string' ? value.id : undefined;
			if (model !== undefined && id !== undefined)
				refs.push({ model, id, field: at, ...(kind.where === undefined ? {} : {
					where: kind.where
				}) });
		}
		for (const child of kindChildren(kind, value, at, traversal)) visit(child.kind, child.value, child.path);
	}
	if (Result.isFailure(result)) {
		function valid(kind: Kind, raw: unknown, at: string): void {
			const decoded = Schema.decodeUnknownResult(input_schema(kind), {
				errors: 'all',
				onExcessProperty: 'error'
			})(raw);
			if (Result.isSuccess(decoded)) {
				visit(kind, decoded.success, at);
				return;
			}
			if (kind.many === true || kind.kind === 'record' || kind.kind === 'object' || (kind.kind === 'union' && 'arms' in kind)) {
				for (const child of kindChildren(kind, raw, at)) {
					if (kind.many !== true && kind.kind === 'object' && child.key !== undefined && !Object.hasOwn(kind.fields, child.key)) continue;
					valid(child.kind, child.value, child.path);
				}
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
	visit({ kind: 'object', fields: original }, result.success, '');
	return { value: result.success, problems: [], refs, ...(custom.length === 0 ? {} : { custom }) };
}


/**
 * The wire input of an automation keeps selections as ids until its declared authority loads them. `spec` is the
 * manifest's (or an effect's) decoded input declaration.
 */
export const decodeAutomationInput = (
	spec: typeof AutomationInputSchema.Type | undefined,
	input: Json | undefined
): Decoded => {
	const fields = spec ?? {};
	const decoded = decodeInput(automation_fields(fields), input);
	for (const [name, kind] of Object.entries(fields)) {
		const values = Predicate.isObject(input) ? input[name] : undefined;
		if (kind.kind === 'rows' && EffectArray.isArray(values) && values.length > LIMITS.page.max)
			decoded.problems.push({ path: name, message: `select at most ${LIMITS.page.max} rows` });
	}
	return decoded;
};
