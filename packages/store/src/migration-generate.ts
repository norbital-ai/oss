// Migration file authoring is separate from runtime validation, so a cell applying files carries no SQL generator.
import { Effect } from 'effect';
import { q } from './sql.ts';
import { StoreError } from './errors.ts';
import { archive_of, check_squash_sources, checksum_of, type MigrationFile } from './migrate.ts';
import { generateWithPlan } from './migration-generate-core.ts';
import { plan } from './schema/build.ts';
import type { SchemaSpec } from './schema/spec.ts';
import type { SchemaObject } from './schema/ddl.ts';
import type { Sql } from './read/sql.ts';

/** Explicit factory reset of a dedicated namespace, including objects left by older declarations. */
export const destroy_namespace = (namespace: string): readonly Sql[] => [
	{ text: `DROP SCHEMA IF EXISTS ${q(namespace)} CASCADE`, params: [] },
	{ text: `CREATE SCHEMA ${q(namespace)}`, params: [] }
];

const refuse = (code: 'migration_invalid', message: string) =>
	Effect.fail(StoreError.of(code, 'admission', message));

/**
 * The next migration file from the last snapshot (`null`: none yet) to `next`, and the snapshot it leaves. `accept`
 * names the destructive steps already accepted; any other destructive step is written without its accept line, so
 * the file is refused until someone adds it.
 */
export const generate = /*#__PURE__*/ generateWithPlan(plan);

/** An editable fresh-database baseline. The host must replay it and its exact archive before recording a receipt. */
export const generate_squash = /*#__PURE__*/ (() =>
	Effect.fn('Store.generate_squash')(function* <E = never>(
		originals: readonly MigrationFile[],
		schema: SchemaSpec,
		options: { readonly name?: string } = {},
		extra: (schema: SchemaSpec) => Effect.Effect<readonly SchemaObject[], E> = () => Effect.succeed([])
	) {
		const ordered = yield* check_squash_sources(originals);
		const archive = archive_of(ordered);
		const baseline = yield* generate(
			null,
			schema,
			{
				number: ordered.length,
				name: `squash_${options.name ?? ''}_${archive.slice(0, 12)}`
			},
			extra
		);
		if (ordered.some((file) => file.name === baseline.file.name))
			return yield* refuse(
				'migration_invalid',
				'the squash filename must differ from every original migration'
			);
		return {
			file: baseline.file,
			replaces: ordered.map((file) => ({ name: file.name, checksum: checksum_of(file) })),
			archive,
			snapshot: baseline.snapshot
		};
	}))();
