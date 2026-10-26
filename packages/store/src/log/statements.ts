import { Effect } from 'effect';
import { StoreError } from '../errors.ts';
import type { Sql } from '../read/sql.ts';
import type { Json } from '../values.ts';
import {
	logLiteral as lit,
	logName as q,
	logPath,
	logSpec,
	type AppendOnlyLogSpec
} from './spec.ts';

export type LogPosition = { readonly at: string; readonly id: string };
export type LogQuery = {
	readonly limit: number;
	readonly order?: 'newest' | 'oldest';
	readonly after?: LogPosition;
	readonly since?: string;
	readonly until?: string;
	readonly text?: string;
	readonly exact?: readonly { readonly path: readonly string[]; readonly value: string }[];
};
const invalid = (message: string) =>
	StoreError.of('invalidInput', 'decode', `append-only log: ${message}`);
const instant = (value: string) => Number.isFinite(Date.parse(value));

/** Prepared operations share the declaration's scope, retention, JSON paths and native maintenance policy. */
export const logStatements = (input: AppendOnlyLogSpec) =>
	Effect.gen(function* () {
		const spec = yield* logSpec(input),
			ns = q(spec.namespace),
			table = `${ns}.event`,
			retired = `${ns}.tenant_retirement`;
		const allowed = new Set(
			spec.indexes.flatMap((index) => index.paths.map((path) => JSON.stringify(path)))
		);
		const scopeValues = (scope: readonly string[]) =>
			scope.length === spec.scope.length && scope.every((value) => value !== '')
				? Effect.succeed(scope)
				: Effect.fail(invalid('scope does not match the declaration'));
		const retained = (alias: string) =>
			`${alias}.recorded_at>statement_timestamp()-interval '${spec.retention.days} days'`;
		const base = (scope: readonly string[]) => {
			const params: Json[] = [...scope];
			const bind = (value: Json, type = '') => {
				params.push(value);
				return `$${params.length}${type === '' ? '' : `::${type}`}`;
			};
			const scopeWhere = spec.scope.map((field, index) => `r.${q(field)}=$${index + 1}`);
			const [partition = '', tenant = ''] = spec.scope;
			const where = [...scopeWhere, retained('r')];
			if (spec.retirement)
				where.push(
					`NOT EXISTS (SELECT 1 FROM ${retired} WHERE ${q(partition)}=$1 AND ${q(tenant)}=$2 AND retired_at IS NOT NULL)`
				);
			return { params, bind, where };
		};
		const position = `to_char(r.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
		const metadata = `(r.event #- ARRAY[${spec.envelope.payload.map(lit).join(',')}]::text[]) || jsonb_build_object('recordedAt',to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'payloadBytes',r.payload_bytes)`;
		const record = `r.event || jsonb_build_object('recordedAt',to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'payloadBytes',r.payload_bytes)`;
		const list = (scope: readonly string[], query: LogQuery, pending: boolean) =>
			Effect.gen(function* () {
				yield* scopeValues(scope);
				if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200)
					return yield* invalid('page limit must be 1–200');
				if (query.order !== undefined && query.order !== 'newest' && query.order !== 'oldest')
					return yield* invalid('order must be newest or oldest');
				if (
					[query.since, query.until, query.after?.at].some(
						(value) => value !== undefined && !instant(value)
					)
				)
					return yield* invalid('time filters and cursor positions must be finite timestamps');
				if (query.after?.id === '') return yield* invalid('cursor id must be nonempty');
				const { params, bind, where } = base(scope);
				for (const filter of query.exact ?? []) {
					if (!allowed.has(JSON.stringify(filter.path)))
						return yield* invalid('filter path has no declared log index');
					where.push(`${logPath(filter.path, 'r.event')}=${bind(filter.value)}`);
				}
				if (query.since !== undefined)
					where.push(`r.occurred_at>=${bind(query.since, 'timestamptz')}`);
				if (query.until !== undefined)
					where.push(`r.occurred_at<${bind(query.until, 'timestamptz')}`);
				if (query.text !== undefined && query.text !== '')
					where.push(
						`r.document ILIKE ${bind(`%${query.text.replace(/[\\%_]/g, '\\$&')}%`)} ESCAPE '\\'`
					);
				const order = pending || query.order === 'oldest' ? 'ASC' : 'DESC';
				if (query.after !== undefined)
					where.push(
						`(r.occurred_at,r.id) ${order === 'ASC' ? '>' : '<'} (${bind(query.after.at, 'timestamptz')},${bind(query.after.id)})`
					);
				if (pending) {
					where.push(`${logPath(spec.pending.status, 'r.event')}=${lit(spec.pending.prepared)}`);
					where.push(
						`NOT EXISTS (SELECT 1 FROM ${table} terminal WHERE ${[
							...spec.scope.map((field) => `terminal.${q(field)}=r.${q(field)}`),
							`terminal.id=(${logPath(spec.pending.operation, 'r.event')}) || ${lit(spec.pending.terminalSuffix)}`,
							`${logPath(spec.pending.operation, 'terminal.event')}=${logPath(spec.pending.operation, 'r.event')}`,
							`${logPath(spec.pending.status, 'terminal.event')} NOT IN (${spec.pending.unresolved.map(lit).join(',')})`,
							retained('terminal')
						].join(' AND ')})`
					);
				}
				const sql: Sql = {
					text: `SELECT ${pending ? record : metadata} AS ${pending ? 'record' : 'summary'},${position} AS position FROM ${table} r WHERE ${where.join(' AND ')} ORDER BY r.occurred_at ${order},r.id ${order} LIMIT ${bind(query.limit + 1)}`,
					params
				};
				return sql;
			});
		return {
			tenants: (partition: string, after?: string) => {
				if (!spec.retirement || partition === '')
					return Effect.fail(invalid('tenant enumeration needs a partitioned retirement policy'));
				const tenant = q(spec.scope[1] ?? '');
				return Effect.succeed({
					text: `SELECT ${tenant} AS tenant FROM ${retired} WHERE ${q(spec.scope[0] ?? '')}=$1${after === undefined ? '' : ` AND ${tenant}>$2`} ORDER BY ${tenant} LIMIT ${spec.retention.batch}`,
					params: after === undefined ? [partition] : [partition, after]
				} satisfies Sql);
			},
			query: (scope: readonly string[], query: LogQuery) => list(scope, query, false),
			pending: (scope: readonly string[], query: Pick<LogQuery, 'limit' | 'after'>) =>
				list(scope, query, true),
			detail: (scope: readonly string[], id: string) =>
				Effect.gen(function* () {
					yield* scopeValues(scope);
					const { params, bind, where } = base(scope);
					where.push(`r.id=${bind(id)}`);
					return {
						text: `SELECT ${record} AS record FROM ${table} r WHERE ${where.join(' AND ')}`,
						params
					} satisfies Sql;
				}),
			append: (scope: readonly string[], events: readonly Json[]) =>
				Effect.gen(function* () {
					yield* scopeValues(scope);
					return {
						text: `SELECT ${ns}.append(${[...scope.map((_, i) => `$${i + 1}`), `$${scope.length + 1}::jsonb`].join(',')})`,
						params: [...scope, JSON.stringify(events)]
					} satisfies Sql;
				}),
			isRetired: (scope: readonly string[]) => {
				if (!spec.retirement || scope.length !== 2 || scope.some((value) => value === ''))
					return Effect.fail(invalid('retirement needs partition and tenant'));
				return Effect.succeed({
					text: `SELECT EXISTS (SELECT 1 FROM ${retired} WHERE ${q(spec.scope[0] ?? '')}=$1 AND ${q(spec.scope[1] ?? '')}=$2 AND retired_at IS NOT NULL) AS retired`,
					params: [...scope]
				} satisfies Sql);
			},
			retire: (scope: readonly string[]) => {
				if (!spec.retirement || scope.length !== 2 || scope.some((value) => value === ''))
					return Effect.fail(invalid('retirement needs partition and tenant'));
				return Effect.succeed({
					text: `SELECT ${ns}.retire_tenant($1,$2)`,
					params: [...scope]
				} satisfies Sql);
			},
			purge: (scope: readonly string[]) => {
				if (!spec.retirement || scope.length !== 2 || scope.some((value) => value === ''))
					return Effect.fail(invalid('purge needs partition and retired tenant'));
				return Effect.succeed({
					text: `SELECT ${ns}.purge_tenant($1,$2) AS removed`,
					params: [...scope]
				} satisfies Sql);
			},
			expire: (partition?: string) => {
				if (spec.retirement)
					return partition === undefined || partition === ''
						? Effect.fail(invalid('expiry needs a partition'))
						: Effect.succeed({
								text: `SELECT ${ns}.expire($1) AS removed`,
								params: [partition]
							} satisfies Sql);
				return Effect.succeed({
					text: `WITH expired AS (SELECT ctid FROM ${table} WHERE recorded_at<=statement_timestamp()-interval '${spec.retention.days} days' ORDER BY recorded_at,id LIMIT ${spec.retention.batch} FOR UPDATE SKIP LOCKED), removed AS (DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM expired) RETURNING 1) SELECT count(*)::integer AS removed FROM removed`,
					params: []
				} satisfies Sql);
			}
		};
	});
