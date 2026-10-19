import { Effect, Request, RequestResolver } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Bindings, Reader, RowData } from '../contracts.ts';
import type { ReadIR, SelectIR } from '../../protocol/ir-types.ts';
import type { EngineManifest } from '../manifest.ts';
import type { ReadsShape as ReadEngine } from '../services.ts';
import { type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { applyReadProjection, assertReadSubset } from './projection.ts';
type Declaration = {
	fields: readonly string[];
	context: readonly string[];
};
type ProjectionPorts = {
	manifest: EngineManifest;
	context(
		collection: string,
		id: string,
		columns: readonly string[],
		revision: number | undefined,
		bindings: Bindings
	): Effect.Effect<RowData | null, EngineError>;
	invoke(
		collection: string,
		record: RowData,
		fields: readonly string[],
		reader: Extract<
			Reader,
			{
				as: 'caller';
			}
		>,
		bindings: Bindings
	): Effect.Effect<Json, EngineError>;
};
const checked = <A>(read: () => A) =>
	Effect.try({
		try: read,
		catch: (error) =>
			error instanceof BoltError
				? error
				: BoltError.make(
						'badAnswer',
						'deliver',
						error instanceof Error ? error.message : String(error),
						error
					)
	});
const object = (value: Json): RowData | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as RowData)
		: undefined;
class ContextRead extends Request.Class<
	{
		source: ReadIR;
		columns: readonly string[];
		bindings: Bindings;
	},
	RowData | null,
	EngineError
> {}
/** Batch trusted captures only within this read engine and the same bindings object. */
export function projectionContext(raw: Pick<ReadEngine, 'run'>): ProjectionPorts['context'] {
	const resolver = RequestResolver.makeWith<ContextRead>({
		batchKey: (entry) => entry.request.bindings,
		delay: Effect.yieldNow,
		collectWhile: () => true,
		runAll: Effect.fn('Bolt.projectionContext')(function* (
			entries: readonly [Request.Entry<ContextRead>, ...Request.Entry<ContextRead>[]]
		) {
			const answers = yield* raw.run(
				entries.map((entry) => entry.request.source),
				{ as: 'workspace' },
				entries[0].request.bindings
			);
			for (const [index, entry] of entries.entries()) {
				const answer = answers[index];
				const keep = new Set(['id', 'revision', ...entry.request.columns]);
				yield* Request.succeed(
					entry,
					answer === null || answer === undefined
						? null
						: Object.fromEntries(
								Object.entries(answer as RowData).filter(([field]) => keep.has(field))
							)
				);
			}
		})
	});
	return (collection, id, columns, revision, bindings) => {
		const source: ReadIR =
			revision === undefined
				? {
						kind: 'get',
						collection,
						id,
						select: { fields: [...new Set(['id', 'revision', ...columns])], relations: {} }
					}
				: { kind: 'history', collection, id, at: { _tag: 'Revision', revision }, full: true };
		return Effect.request(new ContextRead({ source, columns, bindings }), resolver);
	};
}
/** Runs only after the original native row and field authorization has succeeded. */
export function readProjector(ports: ProjectionPorts) {
	const declarations = new Map<string, Declaration>();
	for (const [name, spec] of Object.entries(ports.manifest.collections)) {
		const declaration = (
			spec.read as typeof spec.read & {
				projection?: Declaration;
			}
		).projection;
		if (declaration !== undefined) declarations.set(name, declaration);
	}
	return Effect.fnUntraced(function* (
		read: ReadIR,
		answer: Json,
		reader: Reader,
		bindings: Bindings
	): Effect.fn.Return<Json, EngineError> {
		if (reader.as !== 'caller' || declarations.size === 0) return answer;
		const caller = reader;
		const row = Effect.fn('Bolt.row')(function* (
			collection: string,
			selected: RowData,
			select?: SelectIR,
			revision?: number
		): Effect.fn.Return<RowData, EngineError> {
			let result = { ...selected };
			const declaration = declarations.get(collection);
			const fields =
				declaration?.fields.filter(
					(field) =>
						Object.hasOwn(selected, field) && !(object(selected[field]!)?.['$masked'] === true)
				) ?? [];
			if (fields.length > 0 && declaration !== undefined) {
				if (typeof selected['id'] !== 'string')
					return yield* Effect.fail(
						BoltError.make(
							'invalid',
							'deliver',
							'Projected native row requires its actual identity.'
						)
					);
				const context = yield* ports.context(
					collection,
					selected['id'],
					[...new Set([...declaration.context, ...fields])],
					revision,
					bindings
				);
				if (context === null || context['id'] !== selected['id'])
					return yield* Effect.fail(
						BoltError.make(
							'forbidden',
							'deliver',
							'Original read projection context is unavailable.'
						)
					);
				for (const field of fields) {
					if (!Object.hasOwn(context, field))
						return yield* Effect.fail(
							BoltError.make(
								'forbidden',
								'deliver',
								'Original projected input capture is unavailable.'
							)
						);
					yield* checked(() => assertReadSubset(context[field]!, selected[field]!));
					yield* checked(() => assertReadSubset(selected[field]!, context[field]!));
				}
				for (const column of declaration.context) {
					if (!Object.hasOwn(selected, column) || object(selected[column]!)?.['$masked'] === true)
						continue;
					if (!Object.hasOwn(context, column))
						return yield* Effect.fail(
							BoltError.make(
								'forbidden',
								'deliver',
								'Original read context changed during projection.'
							)
						);
					yield* checked(() => assertReadSubset(context[column]!, selected[column]!));
					yield* checked(() => assertReadSubset(selected[column]!, context[column]!));
				}
				const captured = { ...selected, ...context };
				const narrowed = yield* ports.invoke(collection, captured, fields, caller, bindings);
				result = { ...(yield* checked(() => applyReadProjection(selected, narrowed, fields))) };
			}
			for (const [name, relation] of Object.entries(select?.relations ?? {})) {
				const value = selected[name];
				if (value === undefined || value === null) continue;
				if (relation.many) {
					if (!Array.isArray(value))
						return yield* Effect.fail(
							BoltError.make(
								'invalid',
								'deliver',
								'Projected native relation requires its original rows.'
							)
						);
					result[name] = yield* Effect.all(
						value.map(
							Effect.fnUntraced(function* (item: Json) {
								const existing = object(item);
								if (existing === undefined)
									return yield* Effect.fail(
										BoltError.make(
											'invalid',
											'deliver',
											'Projected native relation requires original records.'
										)
									);
								return yield* row(relation.target, existing, relation.select);
							})
						),
						{ concurrency: 'unbounded' }
					);
				} else {
					const existing = object(value);
					if (existing === undefined)
						return yield* Effect.fail(
							BoltError.make(
								'invalid',
								'deliver',
								'Projected native relation requires its original record.'
							)
						);
					result[name] = yield* row(relation.target, existing, relation.select);
				}
			}
			return result;
		});
		if (read.kind === 'get')
			return yield* answer === null
				? Effect.succeed(null)
				: row(read.collection, object(answer)!, read.select);
		if (read.kind === 'read') {
			const page = object(answer);
			if (page === undefined || !Array.isArray(page['rows'])) return answer;
			return {
				...page,
				rows: yield* Effect.all(
					page['rows'].map((value) => row(read.collection, object(value)!, read.select)),
					{ concurrency: 'unbounded' }
				)
			};
		}
		if (read.kind === 'similar')
			return yield* Array.isArray(answer)
				? Effect.all(
						answer.map((value) => row(read.collection, object(value)!, read.select)),
						{ concurrency: 'unbounded' }
					)
				: Effect.succeed(answer);
		if (read.kind === 'history') {
			if (read.full === true) {
				const record = object(answer);
				return yield* record === undefined
					? Effect.succeed(answer)
					: row(
							read.collection,
							record,
							undefined,
							typeof record['revision'] === 'number' ? record['revision'] : undefined
						);
			}
			if (!Array.isArray(answer)) return answer;
			return yield* Effect.all(
				answer.map(
					Effect.fnUntraced(function* (value: Json) {
						const entry = object(value),
							changed = entry === undefined ? undefined : object(entry['changed']!);
						if (entry === undefined || changed === undefined) return value;
						if (typeof entry['revision'] !== 'number')
							return yield* Effect.fail(
								BoltError.make(
									'invalid',
									'deliver',
									'Read projection requires the actual historical revision.'
								)
							);
						const projected = yield* row(
							read.collection,
							{ ...changed, id: read.id },
							undefined,
							entry['revision']
						);
						const { id: _identity, ...fields } = projected;
						return { ...entry, changed: fields };
					})
				),
				{ concurrency: 'unbounded' }
			);
		}
		return answer;
	});
}
