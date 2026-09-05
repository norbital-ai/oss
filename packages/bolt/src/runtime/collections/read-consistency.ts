import { Context, Effect, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import type * as Database from '#lib/runtime/facilities/database.js';
import {
	executeBuilt,
	toStatement,
	transactionSql,
	type Statement
} from '#lib/runtime/persistence.js';

export type ReadSnapshot = Statement & {
	readonly fingerprint: string;
	readonly tables: ReadonlyArray<string>;
};

export const READ_CONFLICT_MESSAGE =
	'Data used to validate this change has changed. Refresh and retry.';

/** Only preparation installs this recorder; ordinary reads and post-commit hooks incur no work. */
export const PreparingReads = Context.Reference<Array<ReadSnapshot> | undefined>(
	'@norbital-ai/bolt/PreparingReads',
	{ defaultValue: () => undefined }
);

const snapshotResult = Schema.Struct({
	rows: Schema.Array(Schema.Json),
	fingerprint: Schema.String
});
const fingerprint = (alias: string) =>
	`encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(${alias}) order by to_jsonb(${alias})::text), '[]'::jsonb)::text, 'UTF8')), 'hex')`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Fingerprint the exact SQL result in the same database read that supplies the hook's values. */
export const executeObservedRead = (
	effectId: EffectId,
	database: Database.Interface,
	query: Parameters<typeof executeBuilt>[2],
	knownTables: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const snapshots = yield* PreparingReads;
		if (snapshots === undefined) return yield* executeBuilt(effectId, database, query);
		const statement = toStatement(query.toSQL());
		const result = yield* database.execute(effectId, {
			_tag: 'Query',
			sql: `select coalesce(jsonb_agg(to_jsonb(bolt_observed_row)), '[]'::jsonb) as rows, ${fingerprint('bolt_observed_row')} as fingerprint from (${statement.sql}) as bolt_observed_row`,
			parameters: statement.parameters
		});
		const observed = yield* Schema.decodeUnknownEffect(snapshotResult)(result.rows[0]).pipe(
			Effect.orDie
		);
		snapshots.push({
			...statement,
			fingerprint: observed.fingerprint,
			tables: knownTables.filter(
				(table) =>
					statement.sql.includes(quote(table)) ||
					new RegExp(`\\b(?:from|join)\\s+${table}\\b`, 'i').test(statement.sql)
			)
		});
		return { ...result, rows: observed.rows };
	});

/** Brief ordered locks prevent phantoms between revalidation and the write's atomic commit. */
export function readConsistencyStatements(
	snapshots: ReadonlyArray<ReadSnapshot>,
	writeTables: ReadonlyArray<string>
): ReadonlyArray<Statement> {
	const tables = [...new Set([...writeTables, ...snapshots.flatMap((read) => read.tables)])].sort();
	const unique = new Map(
		snapshots.map((read) => [JSON.stringify([read.sql, read.parameters, read.fingerprint]), read])
	);
	return [
		...tables.map((table) =>
			transactionSql(`lock table ${quote(table)} in share row exclusive mode`)
		),
		...[...unique.values()].map((read) =>
			transactionSql(
				`select bolt_assert((select ${fingerprint('bolt_observed_row')} from (${read.sql}) as bolt_observed_row) = $${read.parameters.length + 1}, $${read.parameters.length + 2})`,
				[...read.parameters, read.fingerprint, READ_CONFLICT_MESSAGE]
			)
		)
	];
}
