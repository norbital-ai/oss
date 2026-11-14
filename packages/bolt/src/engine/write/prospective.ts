// A write callback's `as_of: 'act'` read roots: stored rows overlaid with the act's own rows (what the model will hold
// once the act commits), answered inside the act's one planning scope; every other read goes to the act's workspace bridge.
import { Effect, Predicate } from 'effect';
import type { Sql } from '@norbital-ai/host-api';
import type { Bindings, CrossAnswer, EngineActor, RowData } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import type { EngineError } from '../errors.ts';
import type { CrossCall } from '../services.ts';
import type { ListRead } from '@norbital-ai/store';
import { TenantDb } from '../db/tenant-db.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { readOptions } from '../query/reader.ts';
import { LIMITS } from '../contracts.ts';
import {
	null_row_sql,
	q,
	RECORD_LABEL_COLUMN,
	SEARCH_COLUMN,
	EMBEDDING_COLUMN,
	index_column,
	type Catalog
} from '@norbital-ai/store';
import { read_engine } from '../query/engine.ts';
import { compile } from '@norbital-ai/store';
import { withDefaults, type Item } from './flatten.ts';
import { database_value } from '@norbital-ai/store';
import { k, type WriteEngine } from './act.ts';
import { isObj } from '../agent/draft.ts';

/** A write callback's bridge: an `as_of: 'act'` root overlays `staged` (the act's rows when the callback runs) on stored rows. */
export function prospectiveBridge(
	e: WriteEngine,
	cat: Catalog,
	b: Bindings,
	actor: EngineActor,
	staged: readonly Item[],
	pre: ReadonlyMap<string, RowData>,
	originalBridge: ReturnType<NonNullable<WriteEngine['bridge']>>
): ReturnType<NonNullable<WriteEngine['bridge']>> {
	const m = e.manifest;
	/** One read of a root with `as_of: 'act'`: the stored rows overlaid with the act's own (`staged`). */
	const overlay = (nativeRead: ListRead) =>
		Effect.gen(function* (): Effect.fn.Return<CrossAnswer, EngineError> {
			// The original bridge captures the stored source baseline for the act's native lock/fingerprint contract.
			const baseline = yield* originalBridge.cross([{ _tag: 'read', read: nativeRead }]);
			if (baseline.length !== 1)
				return yield* Effect.fail(
					BoltError.make(
						'prepared_read',
						'guest',
						'a prospective read requires its actual native source baseline'
					)
				);
			const first = baseline[0];
			if (first === undefined)
				return yield* BoltError.make('prepared_read', 'guest', 'The prospective read has no baseline answer.');
			if (first.ok !== true) return first;
			const groups = new Map<string, Item[]>();
			for (const item of staged) {
				const source = cat.exposures.get(item.change.model);
				if (source === undefined)
					return yield* BoltError.make('prepared_read', 'guest', 'A prospective source has no declared model.');
				const rows = groups.get(source.model.name) ?? [];
				rows.push(item);
				groups.set(source.model.name, rows);
			}
			const sources = new Map(
				[...groups.keys()].map((model, index) => [model, `__bolt_prepared_${index}`])
			);
			const compiled = yield* compile(
				cat,
				nativeRead,
				readOptions({ as: 'workspace' }, b, { sources })
			).pipe(Effect.mapError(from_store));
			if (!compiled.dependencies.complete)
				return yield* Effect.fail(
					BoltError.make(
						'prepared_read',
						'guest',
						'prospective reads require complete native compiler dependency proof'
					)
				);
			const nativeRows = new Map<string, RowData[]>();
			for (const [model, group] of groups) {
				// Only compiler-proven native dependencies enter the overlay, never SQL text matching.
				const fields = compiled.dependencies.models.get(model);
				if (fields === undefined) {
					sources.delete(model);
					continue;
				}
				const spec = m.models[model];
				if (spec === undefined)
					return yield* BoltError.make('prepared_read', 'guest', 'A prospective source has no storage declaration.');
				const generated = new Set([
					...Object.keys(spec.computed ?? {}),
					...Object.entries(spec.fields).flatMap(([field, definition]) =>
						['seq', 'sum', 'count'].includes(definition.kind) ? [field] : []
					),
					RECORD_LABEL_COLUMN,
					SEARCH_COLUMN,
					EMBEDDING_COLUMN,
					...Object.keys(cat.models.get(model)?.indexes ?? {}).map(index_column)
				]);
				if ([...fields].some((field) => generated.has(field)))
					return yield* Effect.fail(
						BoltError.make(
							'prepared_computed',
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
								'prepared_upsert',
								'guest',
								'prospective sources require resolved native row identities'
							)
						);
					const old =
						item.change.op === 'update'
							? pre.get(k(item.change.model, item.change.id))
							: undefined;
					if (item.change.op === 'update' && old === undefined)
						return yield* Effect.fail(
							BoltError.make(
								'prepared_previous',
								'guest',
								'a prospective update requires its actual stored pre-image'
							)
						);
					const values = {
						...old,
						...(item.change.op === 'create' ? item.change.values : item.change.set)
					};
					// defaults land as the commit will write them; the required check is the commit's own
					if (item.change.op === 'create') withDefaults(m, cat, model, values, actor, b);
					rows.push({
						id: item.change.id,
						...Object.fromEntries(
							Object.entries(values).map(([field, value]) => [
								field,
								database_value(value, cat.models.get(model)?.fields.get(field))
							])
						)
					});
				}
				nativeRows.set(model, rows);
			}
			const withSources = (statement: Sql): Sql => {
				const params = [...statement.params];
				const ctes = [...nativeRows].map(([model, rows]) => {
					const group = groups.get(model), source = sources.get(model);
					if (group === undefined || source === undefined)
						throw BoltError.make('prepared_read', 'guest', 'A prospective source lost its row identities.');
					params.push(JSON.stringify(rows));
					const argument = `$${params.length}::jsonb`;
					params.push(JSON.stringify(group.map((item) => item.change.id)));
					const identities = `$${params.length}::jsonb`;
					return `${q(source)} AS (SELECT original.* FROM ${q(model)} original WHERE NOT (original.id::text IN (SELECT jsonb_array_elements_text(${identities}))) UNION ALL SELECT * FROM jsonb_populate_recordset(${null_row_sql(model, cat.models.get(model)?.fields.keys() ?? [])},${argument}))`;
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
						return withSources(
							nativeRead.cte === undefined
								? compiled.sql
								: {
										text: `WITH ${q(nativeRead.cte)} AS (${compiled.sql.text}) SELECT 0 AS m, (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM ${q(nativeRead.cte)} s) AS j`,
										params: compiled.sql.params
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
							'too_large',
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
							'too_large',
							'guest',
							'the prospective native source statement exceeds the guest read byte budget'
						)
					);
			}
			const db = TenantDb.typed({
				...e.db,
				read: (statements) => e.db.read(statements.map(withSources))
			});
			const reader = read_engine({
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
						'prepared_read',
						'guest',
						'the native prospective reader returned an invalid row envelope'
					)
				);
			return { ok: true, value: answer };
		});
	return {
		...originalBridge,
		cross: (calls) =>
			Effect.gen(function* () {
				// a read request's `as_of: 'act'` roots are answered here; every other root and read crosses as it was
				const forwarded = calls.flatMap((call): CrossCall[] => {
					if (call._tag !== 'read' || call.read.kind !== 'request') return [call];
					const roots = call.read.roots.filter((root) => !('read' in root && root.prospective === true));
					return roots.length === 0 ? [] : [{ ...call, read: { ...call.read, roots } }];
				});
				const readAnswers = forwarded.length ? yield* originalBridge.cross(forwarded) : [];
				let forwardedIndex = 0;
				const answers: CrossAnswer[] = [];
				for (const call of calls) {
					const prospective =
						call._tag === 'read' && call.read.kind === 'request'
							? call.read.roots.flatMap((root) =>
									'read' in root && root.prospective === true ? [root] : []
								)
							: [];
					const stored =
						prospective.length > 0 &&
						call._tag === 'read' &&
						call.read.kind === 'request' &&
						call.read.roots.length === prospective.length
							? { ok: true as const, value: {} }
							: readAnswers[forwardedIndex++];
					if (stored === undefined)
						return yield* BoltError.make('prepared_read', 'guest', 'The write callback received fewer answers than its reads.');
					if (prospective.length === 0 || !stored.ok) {
						answers.push(stored);
						continue;
					}
					const value: { [root: string]: Json } = isObj(stored.value) ? { ...stored.value } : {};
					let failed: CrossAnswer | undefined;
					for (const root of prospective) {
						if (root.read.kind !== 'read')
							return yield* BoltError.make('prepared_read', 'guest', `'${root.root}': as_of 'act' reads a page of rows.`);
						const answer = yield* overlay(root.read);
						if (!answer.ok) {
							failed = answer;
							break;
						}
						value[root.root] = answer.value;
					}
					answers.push(failed ?? { ok: true, value });
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
