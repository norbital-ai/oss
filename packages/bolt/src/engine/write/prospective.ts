import { Effect, Predicate } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { PreparedCreateReceipt } from '../../decl/ctx.ts';
import type { CrossAnswer, RowData, Sql } from '../contracts.ts';
import type { ListRead } from '../../protocol/ir-types.ts';
import type { ActRequest } from '../services.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { LIMITS } from '../contracts.ts';
import { q } from '../../protocol/catalog.ts';
import type { EvalEnv } from '../query/eval.ts';
import { readEngine } from '../query/engine.ts';
import { compile } from '../query/sql.ts';
import { Flattener, withDefaults, type Item } from './flatten.ts';
import { canonical, databaseValue, minter, sha256Hex } from './sql.ts';
import { k, readRows, wireRows, judgePre, candidateRoutes, type WriteEngine } from './act.ts';

/** Configured planning preserves every leaf already reserved by a native path. */
export const retainsPrepared = (actual: unknown, reserved: unknown): boolean =>
	Predicate.isObject(reserved) && Predicate.isObject(actual)
		? Object.entries(reserved).every(
				([field, value]) => Object.hasOwn(actual, field) && retainsPrepared(actual[field], value)
			)
		: canonical(actual) === canonical(reserved);

/** The native prepareCreate / after crossing stays inside the act's one planning scope. */
export function prospectiveBridge(
	e: WriteEngine,
	r: ActRequest,
	env: EvalEnv,
	submitted: readonly Item[],
	pre: Map<string, RowData>,
	_own: TenantDbShape,
	identities: Map<string, string>,
	preparedCreates: Map<string, Item>,
	originalBridge: ReturnType<NonNullable<WriteEngine['bridge']>>
): ReturnType<NonNullable<WriteEngine['bridge']>> {
	const m = e.manifest,
		auth = env.authority!,
		b = r.bindings,
		cat = env.cat;
	return {
		...originalBridge,
		cross: (calls) =>
			Effect.gen(function* () {
				const answers: CrossAnswer[] = [];
				const forwarded = calls.filter(
					(call) =>
						call._tag !== 'prepareCreate' && !(call._tag === 'read' && call.read.kind === 'after')
				);
				const readAnswers = forwarded.length ? yield* originalBridge.cross(forwarded) : [];
				let forwardedIndex = 0;
				for (const call of calls) {
					if (call._tag === 'read' && call.read.kind === 'after') {
						const nativeRead: ListRead = call.read.query ?? {
							kind: 'read' as const,
							collection: call.read.collection,
							where: call.read.where,
							select: {
								fields: [...cat.collections.get(call.read.collection)!.model.fields.keys()],
								relations: {}
							},
							page: { _tag: 'All' as const }
						};
						// The original bridge captures the stored source baseline for the act's native lock/fingerprint contract.
						const baseline = yield* originalBridge.cross([
							{ _tag: 'read', read: nativeRead, params: call.params }
						]);
						if (baseline.length !== 1)
							return yield* Effect.fail(
								BoltError.make(
									'preparedRead',
									'guest',
									'a prospective read requires its actual native source baseline'
								)
							);
						if (baseline[0]?.ok !== true) {
							answers.push(baseline[0]!);
							continue;
						}
						const prospective = new Map(
							submitted.map((item) => [
								JSON.stringify([item.change.collection, item.change.path]),
								item
							])
						);
						for (const [token, item] of preparedCreates) prospective.set(token, item);
						const groups = Map.groupBy(
							[...prospective.values()],
							(item) => cat.collections.get(item.change.collection)!.model.name
						);
						const sources = new Map(
							[...groups.keys()].map((model, index) => [model, `__bolt_prepared_${index}`])
						);
						const nativeRows = new Map<string, RowData[]>();
						for (const [model, group] of groups) {
							const spec = m.models[model]!;
							if (
								Object.keys(spec.computed ?? {}).length ||
								Object.values(spec.fields).some((field) =>
									['seq', 'sum', 'count'].includes(field.kind)
								)
							)
								return yield* Effect.fail(
									BoltError.make(
										'preparedComputed',
										'guest',
										'prospective reads require native generated fields to be materialized before they can be read'
									)
								);
							const rows: RowData[] = [];
							for (const item of group) {
								if (item.change.op === 'delete') continue;
								if (item.change.op !== 'create' && item.change.op !== 'update')
									return yield* Effect.fail(
										BoltError.make(
											'preparedUpsert',
											'guest',
											'prospective sources require resolved native row identities'
										)
									);
								const old =
									item.change.op === 'update'
										? pre.get(k(item.change.collection, item.change.id))
										: undefined;
								if (item.change.op === 'update' && old === undefined)
									return yield* Effect.fail(
										BoltError.make(
											'preparedPrevious',
											'guest',
											'a prospective update requires its actual stored pre-image'
										)
									);
								const values = {
									...old,
									...(item.change.op === 'create' ? item.change.values : item.change.set)
								};
								// A private prepared routing phase can precede derived required fields.
								// Final emission still passes the ordinary complete model admission.
								if (item.change.op === 'create') withDefaults(m, cat, model, values, auth.actor, b);
								rows.push({
									id: item.change.id,
									...Object.fromEntries(
										Object.entries(values).map(([field, value]) => [
											field,
											databaseValue(value, cat.models.get(model)?.fields.get(field))
										])
									)
								});
							}
							nativeRows.set(model, rows);
						}
						const withSources = (statement: Sql): Sql => {
							const params = [...statement.params];
							const ctes = [...nativeRows].map(([model, rows]) => {
								params.push(JSON.stringify(rows));
								const argument = `$${params.length}::jsonb`;
								params.push(JSON.stringify(groups.get(model)!.map((item) => item.change.id)));
								const identities = `$${params.length}::jsonb`;
								return `${q(sources.get(model)!)} AS (SELECT original.* FROM ${q(model)} original WHERE NOT (original.id::text IN (SELECT jsonb_array_elements_text(${identities}))) UNION ALL SELECT * FROM jsonb_populate_recordset(null::${q(model)},${argument}))`;
							});
							const body = statement.text.startsWith('WITH ')
								? statement.text.slice(5)
								: statement.text;
							const text = ctes.length
								? `WITH ${ctes.join(', ')}${statement.text.startsWith('WITH ') ? ', ' : ' '}${body}`
								: statement.text;
							return { text, params };
						};
						// The native read is isolated, so its complete SQL can be checked before the raw driver boundary.
						// The reader compiles the same query and retains its ordinary decoding and row delivery.
						if (nativeRead.page._tag !== 'Limit' || nativeRead.page.limit !== 0) {
							const statement = yield* Effect.try({
								try: () => {
									const compiled = compile(cat, nativeRead, { as: 'workspace' }, b, undefined, {
										sources
									}).sql;
									return withSources(
										nativeRead.cte === undefined
											? compiled
											: {
													text: `WITH ${q(nativeRead.cte)} AS (${compiled.text}) SELECT 0 AS m, (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM ${q(nativeRead.cte)} s) AS j`,
													params: compiled.params
												}
									);
								},
								catch: (error) =>
									error instanceof BoltError
										? error
										: BoltError.make('internal', 'guest', String(error), error)
							});
							if (statement.params.length > LIMITS.statement.params)
								return yield* Effect.fail(
									BoltError.make(
										'tooLarge',
										'guest',
										'the prospective native read exceeds its statement parameter budget'
									)
								);
							if (
								new TextEncoder().encode(statement.text).length +
									new TextEncoder().encode(JSON.stringify(statement.params)).length >
								LIMITS.readBytes
							)
								return yield* Effect.fail(
									BoltError.make(
										'tooLarge',
										'guest',
										'the prospective native source statement exceeds the guest read byte budget'
									)
								);
						}
						const db = TenantDb.typed({
							...e.db,
							read: (statements) => e.db.read(statements.map(withSources))
						});
						const reader = readEngine({
							manifest: m,
							db,
							querySources: { sources },
							allBytes: LIMITS.readBytes
						});
						const result = yield* reader.run([nativeRead], { as: 'workspace' }, b);
						const answer = result[0];
						if (!Predicate.isObject(answer) || !Array.isArray(answer.rows))
							return yield* Effect.fail(
								BoltError.make(
									'preparedRead',
									'guest',
									'the native prospective reader returned an invalid row envelope'
								)
							);
						answers.push({ ok: true, value: call.read.query === undefined ? answer.rows : answer });
						continue;
					}
					if (call._tag !== 'prepareCreate') {
						answers.push(readAnswers[forwardedIndex++]!);
						continue;
					}
					const path = call.path,
						parentPath = path.slice(0, -3),
						relation = path.at(-3),
						index = path.at(-1);
					const staged = submitted.find(
						(item) =>
							item.change.collection === call.collection &&
							canonical(item.change.path) === canonical(path)
					);
					const root =
						staged?.parent === undefined && staged?.change.op === 'create' ? staged : undefined;
					if (
						!Predicate.isObject(call.values) ||
						(root === undefined &&
							(path.length < 3 ||
								typeof relation !== 'string' ||
								path.at(-2) !== 'create' ||
								typeof index !== 'number' ||
								!Number.isSafeInteger(index) ||
								index < 0))
					)
						return yield* Effect.fail(
							BoltError.make(
								'preparedPath',
								'guest',
								'prepareCreate requires an actual staged create or nested native create path'
							)
						);
					const parent = [...submitted, ...preparedCreates.values()].find(
						(item) => canonical(item.change.path) === canonical(parentPath)
					);
					const rel =
						parent === undefined || typeof relation !== 'string'
							? undefined
							: cat.models.get(parent.change.collection)?.many.get(relation);
					if (
						root === undefined &&
						(parent === undefined ||
							!['create', 'update'].includes(parent.change.op) ||
							rel === undefined ||
							rel.child !== call.collection ||
							m.relationships[`${rel.child}.${rel.column}`]?.inverse !== relation)
					)
						return yield* Effect.fail(
							BoltError.make(
								'preparedOwnership',
								'guest',
								'prepareCreate requires an actual declared native relationship under its staged parent'
							)
						);
					const token = JSON.stringify([call.collection, path]),
						previous = preparedCreates.get(token);
					if (identities.has(token) && previous === undefined && root === undefined)
						return yield* Effect.fail(
							BoltError.make(
								'preparedConflict',
								'guest',
								'a prepared create cannot replace a submitted native path'
							)
						);
					const id =
						previous?.change.id ??
						root?.change.id ??
						minter(`${r.invocationId}:prepared:${token}`, b.now)();
					const reservedIdentities = new Map(identities);
					reservedIdentities.set(token, id);
					const flattened = new Flattener(
						m,
						cat,
						minter(
							`${r.invocationId}:prepared:${token}:${sha256Hex(canonical(call.values))}`,
							b.now
						),
						reservedIdentities
					);
					flattened.create(
						call.collection,
						'any',
						call.values,
						path,
						root !== undefined
							? undefined
							: {
									collection: parent!.change.collection,
									id: parent!.change.id,
									rel: relation as string,
									fk: rel!.column
								}
					);
					const candidate = flattened.items[0];
					const paths = new Set([
						...preparedCreates.keys(),
						...flattened.items.map((item) =>
							JSON.stringify([item.change.collection, item.change.path])
						)
					]);
					if (
						flattened.problems.length ||
						candidate?.change.op !== 'create' ||
						paths.size > LIMITS.changesPerAct
					)
						return yield* Effect.fail(
							BoltError.make(
								'preparedValues',
								'guest',
								'prepareCreate accepts admitted native rows and declared relationship actions within the act row budget'
							)
						);
					if (
						root?.change.op === 'create' &&
						Object.entries(root.change.values).some(
							([field, value]) =>
								canonical(
									candidate.change.op === 'create' ? candidate.change.values[field] : undefined
								) !== canonical(value)
						)
					)
						return yield* Effect.fail(
							BoltError.make(
								'preparedValues',
								'guest',
								'a prepared root must preserve every submitted native value'
							)
						);
					if (
						previous?.change.op === 'create' &&
						!retainsPrepared(candidate.change.values, previous.change.values)
					)
						return yield* Effect.fail(
							BoltError.make(
								'preparedConflict',
								'guest',
								'a prepared native path cannot change its original values'
							)
						);
					const wanted = flattened.items.flatMap((item) =>
						item.change.op === 'update' || item.change.op === 'delete'
							? [[item.change.collection, item.change.id] as const]
							: []
					);
					const stored = yield* readRows(e.db, cat, wanted);
					for (const [key, row] of stored) if (!pre.has(key)) pre.set(key, row);
					for (const item of flattened.items) {
						if (item.change.op === 'upsert')
							return yield* Effect.fail(
								BoltError.make(
									'preparedUpsert',
									'guest',
									'prepared native actions require resolved row identities'
								)
							);
						const itemToken = JSON.stringify([item.change.collection, item.change.path]),
							prior = preparedCreates.get(itemToken);
						const before =
							item.change.op === 'create'
								? null
								: (pre.get(k(item.change.collection, item.change.id)) ?? null);
						if (item.change.op !== 'create' && before === null)
							return yield* Effect.fail(
								BoltError.make(
									'preparedPrevious',
									'guest',
									'prepared native relationship changes require their actual stored pre-image'
								)
							);
						const supplied =
							submitted.find(
								(original) =>
									original.change.collection === item.change.collection &&
									canonical(original.change.path) === canonical(item.change.path)
							)?.supplied ?? [];
						if (
							!auth.admin &&
							judgePre(auth, env, item.change.collection, item.change.op, before, supplied) !==
								true &&
							candidateRoutes(m, env, item.change.collection, item.change.op, before, supplied)
								.length === 0
						)
							return yield* Effect.fail(
								BoltError.make(
									'forbidden',
									'guest',
									'the actor has no native authority for the prepared relationship action'
								)
							);
						const values =
							item.change.op === 'create'
								? item.change.values
								: item.change.op === 'update'
									? item.change.set
									: null;
						if (prior !== undefined) {
							const previousValues =
								prior.change.op === 'create'
									? prior.change.values
									: prior.change.op === 'update'
										? prior.change.set
										: null;
							if (
								prior.change.op !== item.change.op ||
								prior.change.id !== item.change.id ||
								!retainsPrepared(values, previousValues)
							)
								return yield* Effect.fail(
									BoltError.make(
										'preparedConflict',
										'guest',
										'a prepared relationship path cannot change its original operation, identity or values'
									)
								);
						}
						preparedCreates.set(itemToken, item);
						identities.set(itemToken, item.change.id);
					}
					const related_sources = flattened.items
						.slice(1)
						.flatMap((item): PreparedCreateReceipt[] =>
							item.change.op === 'create'
								? [
										{
											collection: item.change.collection,
											id: item.change.id,
											path: item.change.path,
											values: item.change.values,
											committed: false,
											phase: 'PREPARED_NATIVE_CREATE',
											invocation_id: r.invocationId,
											related_sources: [],
											related_actions: []
										}
									]
								: []
						);
					const related_actions = yield* Effect.all(
						flattened.items.slice(1).map(
							Effect.fnUntraced(function* (item: Item): Effect.fn.Return<Json, EngineError> {
								const action = {
									collection: item.change.collection,
									id: item.change.id,
									path: item.change.path,
									operation: item.change.op,
									committed: false,
									phase: 'PREPARED_NATIVE_MUTATION',
									invocation_id: r.invocationId
								};
								if (item.change.op !== 'update') return action;
								const previous = (yield* wireRows(
									e.db,
									cat,
									item.change.collection,
									[item.change.id],
									b
								))[0];
								if (previous == null || typeof previous['revision'] !== 'number')
									return yield* Effect.fail(
										BoltError.make(
											'preparedPrevious',
											'guest',
											'a prospective mutation requires its actual native pre-image and revision'
										)
									);
								return {
									...action,
									set: item.change.set,
									previous_revision: previous['revision'],
									previous
								};
							})
						),
						{ concurrency: 'unbounded' }
					);
					answers.push({
						ok: true,
						value: {
							collection: call.collection,
							id,
							path,
							values: candidate.change.values,
							committed: false,
							phase: 'PREPARED_NATIVE_CREATE',
							invocation_id: r.invocationId,
							related_sources,
							related_actions
						} satisfies PreparedCreateReceipt
					});
				}
				return answers;
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed(
						calls.map((): CrossAnswer => ({
							ok: false,
							error: {
								kind: 'bolt',
								code: error instanceof BoltError ? error.code : 'internal',
								message: error.message
							}
						}))
					)
				)
			)
	};
}
