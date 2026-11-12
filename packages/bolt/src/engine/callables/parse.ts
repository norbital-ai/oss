// Callable identities and the public atomic write boundary.
import { Effect, Predicate, Result, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { EngineManifest } from '../manifest.ts';
import type { ActsRequest, ParsedCallable } from '../services.ts';
import type { Verb } from '../write/act.ts';
import { catalog_of } from '../access/pred.ts';
import { LIMITS } from '../contracts.ts';

export const VERBS: readonly Verb[] = ['create', 'update', 'delete', 'erase', 'import'];

export function parse_callable(
	callable: string,
	manifest: EngineManifest
): Result.Result<ParsedCallable, BoltError> {
	const dot = callable.lastIndexOf('.'),
		model = callable.slice(0, dot),
		member = callable.slice(dot + 1);
	const verb = VERBS.find((verb) => verb === member);
	if (verb !== undefined && manifest.exposures[model] !== undefined)
		return Result.succeed({ _tag: 'Verb', model, verb });
	if (manifest.automations[callable] !== undefined)
		return Result.succeed({ _tag: 'Automation', automation: callable });
	return Result.fail(
		BoltError.make('unknown_callable', 'decode', `'${callable}' is not a declared callable`)
	);
}

const isList = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
const MapOptions = Schema.Struct({
	key: Schema.optionalKey(Schema.String)
});

/** Compact public row targets before planning; native engine commands keep their own id representation. */
export function writeTarget(manifest: EngineManifest, model: string, row: Json | undefined): {
	readonly id: string;
	readonly revision?: number;
} {
	if (!Predicate.isObject(row) || typeof row['id'] !== 'string')
		throw BoltError.make('invalid_input', 'decode', `${model} target must be a row.`);
	const revision = row['revision'];
	if ((catalog_of(manifest).models.get(model)?.audit === true || revision !== undefined) &&
		(typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0))
		throw BoltError.make('invalid_input', 'decode', `${model} target must carry a valid revision.`);
	return { id: row['id'], ...(typeof revision === 'number' ? { revision } : {}) };
}

/** Traverse only declared relation actions; business JSON with a target or set key remains an ordinary value. */
export function writeFields(manifest: EngineManifest, model: string, value: Json, mode: 'create' | 'update', depth = 0): Json {
	if (depth > LIMITS.writeDepth)
		throw BoltError.make('overflow', 'decode', `Relation actions nest at most ${LIMITS.writeDepth} deep.`);
	if (!Predicate.isObject(value)) return value;
	return Object.fromEntries(Object.entries<Json>(value).map(([field, actions]) => {
		const relation = catalog_of(manifest).models.get(model)?.many.get(field);
		if (relation === undefined) return [field, actions];
		if (isList(actions) !== (mode === 'create'))
			throw BoltError.make('invalid_input', 'decode', `${model}.${field} takes ${mode === 'create' ? 'a list of new children or existing rows' : 'explicit child actions'}.`);
		if (isList(actions)) return [field, actions.map((row) =>
			Predicate.isObject(row) && Object.hasOwn(row, 'id')
				? writeTarget(manifest, relation.child, row)
				: writeFields(manifest, relation.child, row, 'create', depth + 1))];
		if (!Predicate.isObject(actions)) return [field, actions];
		return [field, Object.fromEntries(Object.entries<Json>(actions).map(([verb, rows]) => {
			if (!['create', 'update', 'delete', 'link', 'unlink'].includes(verb))
				throw BoltError.make('invalid_input', 'decode', `${model}.${field}: unknown child action '${verb}'.`);
			return [verb, isList(rows) ? rows.map((row) => {
				if (verb === 'delete' || verb === 'link' || verb === 'unlink')
					return writeTarget(manifest, relation.child, row);
				if (verb === 'update') return writeUpdate(manifest, relation.child, row, depth + 1);
				return writeFields(manifest, relation.child, row, 'create', depth + 1);
			}) : rows];
		}))];
	}));
}
function writeUpdate(manifest: EngineManifest, model: string, row: Json, depth = 0): Json {
	if (!Predicate.isObject(row)) return row;
	if (Object.keys(row).some((key) => key !== 'target' && key !== 'set'))
		throw BoltError.make('invalid_input', 'decode', `${model} update is { target, set }.`);
	return { ...row, target: writeTarget(manifest, model, row['target']),
		...(row['set'] === undefined ? {} : { set: writeFields(manifest, model, row['set'], 'update', depth) }) };
}

/** Public writes carry rows at every declared update/delete layer. Interior engine commands retain their native ids. */
export const decode_acts = Effect.fn('Callables.decodeActs')(function* (
	manifest: EngineManifest,
	value: unknown,
	settings: unknown = {}
) {
	const decode = <A>(schema: Schema.Decoder<A>, input: unknown) =>
		Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(input).pipe(
			Effect.mapError((error) => BoltError.make('invalid_input', 'decode', error.message))
		);
	const inputs = yield* decode(Schema.Record(Schema.String, Schema.Json), value);
	const options = yield* decode(MapOptions, settings);
	const acts: ActsRequest['acts'][number][] = [];
	const outputs = Object.keys(inputs);
	for (const [name, input] of Object.entries<Json>(inputs)) {
		const callable = yield* Effect.fromResult(parse_callable(name, manifest));
		if (callable._tag !== 'Verb')
			return yield* Effect.fail(
				BoltError.make('invalid_input', 'decode', `${name} is not a generated write.`)
			);
		const observed: Record<string, number> = {};
		const normalized = yield* Effect.try({
			try: (): Json => {
				if (callable.verb === 'import')
					return Predicate.isObject(input) && isList(input['rows'])
						? { ...input, rows: input['rows'].map((row) => writeFields(manifest, callable.model, row, 'create')) }
						: input;
				if (callable.verb === 'erase') {
					if (!Predicate.isObject(input)) return input;
					const rows = input['target'];
					const target = (row: Json | undefined) => {
						const compact = writeTarget(manifest, callable.model, row);
						if (compact.revision !== undefined) observed[compact.id] = compact.revision;
						return compact.id;
					};
					return {
						...input,
						target: isList(rows)
							? rows.map(target)
							: target(rows)
					};
				}
				return isList(input)
					? input.map((row) => {
						if (callable.verb === 'delete') {
							// a non-object row is the planner's to refuse, with its row index (as an update's is)
							if (!Predicate.isObject(row)) return row;
							if (Object.keys(row).some((key) => key !== 'target'))
								throw BoltError.make('invalid_input', 'decode', `${callable.model} delete is { target }.`);
							return { target: writeTarget(manifest, callable.model, row['target']) };
						}
						return callable.verb === 'update' ? writeUpdate(manifest, callable.model, row)
							: writeFields(manifest, callable.model, row, 'create');
					})
					: input;
			},
			catch: (error) =>
				error instanceof BoltError
					? error
					: BoltError.make('invalid_input', 'decode', String(error), error)
		});
		acts.push({
			model: callable.model,
			verb: callable.verb,
			input: normalized,
			...(Object.keys(observed).length === 0 ? {} : { observed })
		});
	}
	return {
		acts,
		outputs,
		options: {
			...(options.key === undefined ? {} : { key: options.key })
		}
	};
});
