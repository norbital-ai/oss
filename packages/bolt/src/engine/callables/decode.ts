// Typed input decoding and reference discovery share std/kind's one codec.
import { inputSchema, type Fields, type Kind, type Value, type Where } from '@norbital-ai/std/kind';
import { Array as EffectArray, Effect, Predicate, Result, Schema, SchemaIssue } from 'effect';
import { exposureOf, defaultFields } from '@norbital-ai/store';
import type { Json } from '../../decl/values.ts';
import { encodeWire, type Wired } from '@norbital-ai/std/wire';
import { BUILTIN_FIELDS } from '../../decl/builtin-fields.ts';
import { nullableOfExpr } from '../../decl/model.ts';
import { catalogOf } from '../access/pred.ts';
import { BoltError, storeSync } from '../../protocol/errors.ts';

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
/** A keyed list's items (`{ kind: 'list', key }`) each carry a distinct, non-empty key; offenders by path. */
function keyProblems(kind: Kind, raw: unknown, at: string, out: Decoded['problems']): void {
	const join = (k: string) => (at ? `${at}.${k}` : k);
	switch (kind.kind) {
		case 'list': {
			if (!EffectArray.isArray(raw)) return;
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
export function decodeInput(
	spec: InputSpec | undefined,
	input: Json | undefined,
	customFields?: import('../manifest.ts').EngineManifest['customFields']
): Decoded {
	const original = spec ?? {};
	const declarations: Decoded['problems'] = [];
	const shapeOf = (name: string) =>
		customFields?.[name]?.shape ??
		Object.entries(BUILTIN_FIELDS).find(([key]) => key === name)?.[1].spec.shape;
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
					kind.many === true ? { kind: 'list', of: resolvedShape } : resolvedShape;
				const { optional: _optional, default: _default, ...body } = resolved;
				const { kind: _kind, of: _of, many: _many, ...common } = kind;
				return { ...body, ...common };
			}
			case 'list':
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
				return 'of' in kind
					? { ...kind, of: kind.of.map((arm) => expand(arm, path, seen)) }
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
	if (customFields !== undefined) {
		spec = Object.fromEntries(
			Object.entries(original).map(([name, kind]) => [name, expand(kind, name, new Set())])
		);
		if (declarations.length > 0) return { value: undefined, problems: declarations, refs: [] };
	}
	const codec = inputSchema({ kind: 'object', fields: spec ?? {} });
	const result = Schema.decodeUnknownResult(codec, { errors: 'all', onExcessProperty: 'error' })(
		input ?? {}
	);
	const keyed: Decoded['problems'] = [];
	keyProblems({ kind: 'object', fields: spec ?? {} }, input ?? {}, '', keyed);

	const refs: Decoded['refs'] = [];
	const custom: NonNullable<Decoded['custom']>[number][] = [];
	function visit(kind: Kind, value: Value, at: string, scalar = false): void {
		if (value === null) return;
		if (
			!scalar &&
			'many' in kind &&
			kind.many === true &&
			EffectArray.isArray<typeof value>(value)
		) {
			value.forEach((item, index) => visit(kind, item, `${at}.${index}`, true));
			return;
		}
		switch (kind.kind) {
			case 'custom': {
				if (customFields === undefined) return;
				if (customFields[kind.of]?.check === true)
					custom.push({ name: kind.of, value: encodeWire(value), path: at });
				const shape = shapeOf(kind.of);
				if (shape !== undefined) visit(shape, value, at);
				return;
			}
			case 'id':
				if (typeof value === 'string')
					refs.push({
						model: kind.of,
						id: value,
						field: at,
						...(kind.where === undefined ? {} : { where: kind.where })
					});
				return;
			case 'list':
				if (EffectArray.isArray<typeof value>(value))
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
						if (
							Result.isSuccess(
								Schema.decodeUnknownResult(
									inputSchema(customFields === undefined ? arm : expand(arm, at, new Set()))
								)(value)
							)
						) {
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
			if (kind.kind === 'list' && EffectArray.isArray(raw))
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
	visit({ kind: 'object', fields: original }, result.success, '');
	return { value: result.success, problems: [], refs, ...(custom.length === 0 ? {} : { custom }) };
}

/** A declared output is decoded once at the guest boundary, including model rows and their native field values. */
export function outputSchema(
	manifest: import('../manifest.ts').EngineManifest,
	output: import('../../decl/fields.ts').OutputKind
): Schema.Decoder<Wired> {
	const fields = (entries: Readonly<Record<string, import('../../decl/fields.ts').OutputKind>>) =>
		Schema.Struct(
			Object.fromEntries(
				Object.entries(entries).map(
					([name, field]): [
						string,
						Schema.Decoder<Wired> | Schema.optionalKey<Schema.Decoder<Wired>>
					] => [
						name,
						field.optional === true || field.default !== undefined
							? Schema.optionalKey(outputSchema(manifest, field))
							: outputSchema(manifest, field)
					]
				)
			)
		);
	let codec: Schema.Decoder<Wired>;
	switch (output.kind) {
		case 'row': {
			const catalog = catalogOf(manifest);
			const model = manifest.models[output.of];
			const info = storeSync(exposureOf(catalog, output.of));
			const identity = (name: string) =>
				catalog.models.get(name)?.fields.get('id')?.pg === 'uuid'
					? inputSchema({ kind: 'id', of: name })
					: Schema.String;
			const columns: Record<
				string,
				Schema.Decoder<Wired> | Schema.optionalKey<Schema.Decoder<Wired>>
			> = {};
			for (const name of defaultFields(info, true)) {
				const relation = manifest.relationships[`${output.of}.${name}`];
				const declared = model?.fields[name];
				const computed = model?.computed?.[name];
				let member: Schema.Decoder<Wired>;
				if (name === 'id') member = identity(output.of);
				else if (relation !== undefined) {
					member =
						typeof relation.to === 'string'
							? identity(relation.to)
							: Schema.Union(
									relation.to.map((target) =>
										Schema.Struct({ model: Schema.Literal(target), id: identity(target) })
									)
								);
					if (relation.optional) member = Schema.NullOr(member);
				} else if (declared !== undefined) member = outputSchema(manifest, declared);
				else if (computed !== undefined) {
					member =
						computed.kind === 'decimal'
							? inputSchema({ kind: 'decimal', scale: computed.scale ?? 0 })
							: inputSchema({ kind: computed.kind });
					if (model === undefined || nullableOfExpr(computed.expr, model))
						member = Schema.NullOr(member);
				} else if (name === 'revision') member = Schema.Int;
				else if (name === 'created_at' || name === 'updated_at')
					member = inputSchema({ kind: 'instant' });
				else if (name === 'created_by' || name === 'updated_by')
					member = Schema.NullOr(identity('sys_user'));
				else
					throw BoltError.make(
						'badAnswer',
						'guest',
						`Unknown output field '${output.of}.${name}'.`
					);
				columns[name] =
					declared !== undefined && ['json', 'custom', 'file'].includes(declared.kind)
						? Schema.optionalKey(member)
						: member;
			}
			codec = Schema.Struct({
				...columns,
				$sync: Schema.optionalKey(Schema.Json),
				$approval: Schema.optionalKey(Schema.Json)
			});
			break;
		}
		case 'custom': {
			const shape =
				manifest.customFields[output.of]?.shape ??
				Object.entries(BUILTIN_FIELDS).find(([name]) => name === output.of)?.[1].spec.shape;
			if (shape === undefined)
				throw BoltError.make('badAnswer', 'guest', `Unknown custom field '${output.of}'.`);
			codec = outputSchema(manifest, shape);
			if (output.many) codec = Schema.Array(codec);
			break;
		}
		case 'json':
			codec = output.shape === undefined ? Schema.Json : outputSchema(manifest, output.shape);
			break;
		case 'list':
			codec = Schema.Array(outputSchema(manifest, output.of));
			break;
		case 'record':
			codec = Schema.Record(Schema.String, outputSchema(manifest, output.of));
			break;
		case 'object': {
			const named = fields(output.fields);
			codec =
				output.rest === undefined
					? named
					: Schema.StructWithRest(named, [
							Schema.Record(Schema.String, outputSchema(manifest, output.rest))
						]);
			break;
		}
		case 'union':
			codec =
				'of' in output
					? Schema.Union(output.of.map((arm) => outputSchema(manifest, arm)))
					: Schema.Union(
							Object.entries(output.arms).map(([tag, arm]) =>
								Schema.Struct({ ...fields(arm).fields, [output.by]: Schema.Literal(tag) })
							)
						);
			break;
		default:
			return inputSchema(output);
	}
	return output.optional === true ? Schema.NullOr(codec) : codec;
}
export const decodeOutput = (
	manifest: import('../manifest.ts').EngineManifest,
	output: import('../../decl/fields.ts').OutputKind,
	value: Json
): Effect.Effect<Json, BoltError> =>
	Effect.try({
		try: () => outputSchema(manifest, output),
		catch: (error) =>
			error instanceof BoltError
				? error
				: BoltError.make('badAnswer', 'guest', String(error), error)
	}).pipe(
		Effect.flatMap((codec) => Schema.decodeUnknownEffect(codec)(value)),
		Effect.map(encodeWire),
		Effect.mapError((error) =>
			error instanceof BoltError
				? error
				: BoltError.make('badAnswer', 'guest', error.message, error)
		)
	);
