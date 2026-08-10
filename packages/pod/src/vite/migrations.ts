import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { SYSTEM_COLLECTION_NAMES } from '@norbital-ai/platform-utils/system/collections';
import { NON_TEMPORAL_SYSTEM_COLLECTIONS } from '@norbital-ai/platform-utils/system/workspace-schema';
import {
	migrationFingerprint,
	readMigrationFingerprint,
	writeMigrationFingerprint
} from './migration-fingerprint.js';
const platformSystemWorkspaceSchema = fileURLToPath(
	import.meta.resolve('@norbital-ai/platform-utils/system/workspace-schema')
);

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
const HISTORY_SUFFIX = '_history';

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function sqlStatements(sql: string): string[] {
	return sql
		.split(STATEMENT_BREAKPOINT)
		.map((source) => source.trim())
		.filter(Boolean);
}

/** Mirror generated record-table column DDL into its typed temporal history relation. */
export function mirrorTemporalHistoryDdl(
	sql: string,
	initialTemporalTables: ReadonlySet<string>,
	nonTemporalTables: ReadonlySet<string>
): string {
	const statements = sqlStatements(sql);
	const temporalTables = new Set(initialTemporalTables);

	// The current workspace inventory contains the post-migration name. Walk renames backwards so
	// a generated old_name -> new_name migration still evolves the already-existing old history
	// relation. A dropped record no longer appears in that inventory; dropping a missing history
	// relation is harmless and keeps both halves of the model together.
	for (const statement of [...statements].reverse()) {
		const rename = statement.match(/^ALTER TABLE "([^"]+)"\s+RENAME TO "([^"]+)"\s*;?$/i);
		if (rename && temporalTables.has(rename[2])) temporalTables.add(rename[1]);
		const drop = statement.match(/^DROP TABLE "([^"]+)"(?:\s+CASCADE)?\s*;?$/i);
		if (drop && !nonTemporalTables.has(drop[1])) temporalTables.add(drop[1]);
	}

	const output: string[] = [];
	for (const statement of statements) {
		output.push(statement);

		const create = statement.match(/^CREATE TABLE "([^"]+)"\s*\(/i);
		if (create && temporalTables.has(create[1])) {
			const table = create[1];
			const history = `${table}_history`;
			const tableLiteral = table.replaceAll("'", "''");
			const historyLiteral = history.replaceAll("'", "''");
			output.push(
				`SELECT _norbital_create_history_table('${tableLiteral}'::regclass, '${historyLiteral}');`
			);
			continue;
		}

		const alter = statement.match(/^ALTER TABLE "([^"]+)"\s+([\s\S]+)$/i);
		if (alter && temporalTables.has(alter[1])) {
			const [_, table, operation] = alter;
			const rename = operation.match(/^RENAME TO "([^"]+)"\s*;?$/i);
			if (rename) {
				const nextTable = rename[1];
				output.push(
					`ALTER TABLE ${quoteIdentifier(`${table}_history`)} RENAME TO ${quoteIdentifier(`${nextTable}_history`)};`
				);
				temporalTables.delete(table);
				temporalTables.add(nextTable);
			} else if (/^(?:ADD COLUMN|DROP COLUMN|ALTER COLUMN|RENAME COLUMN)\b/i.test(operation)) {
				output.push(`ALTER TABLE ${quoteIdentifier(`${table}_history`)} ${operation}`);
			}
			continue;
		}

		const drop = statement.match(/^DROP TABLE "([^"]+)"(\s+CASCADE)?\s*;?$/i);
		if (drop && temporalTables.has(drop[1])) {
			const table = drop[1];
			output.push(`DROP TABLE IF EXISTS ${quoteIdentifier(`${table}_history`)}${drop[2] ?? ''};`);
			temporalTables.delete(table);
		}
	}
	return `${output.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`;
}

/**
 * Resolve one collection's `history` setting by importing the definition that carries it.
 *
 * The authored model is the only place the flag lives, so this reads it rather than restating it.
 * A model that cannot be imported is fatal: defaulting to "history on" here would put the generator
 * back in disagreement with the runtime DDL, which is the bug this design exists to prevent.
 */
async function collectionHistoryFlag(modelFile: string): Promise<boolean> {
	let module: unknown;
	try {
		module = await import(pathToFileURL(modelFile).href);
	} catch (caught) {
		throw new Error(
			`Could not import ${modelFile} to resolve its history setting.\n\n` +
				'A collection model is imported directly to read its metadata, so it must be strippable ' +
				'TypeScript — no `enum`, no `namespace`, and no constructor parameter properties.\n\n' +
				`Node said:\n${caught instanceof Error ? caught.message : String(caught)}`,
			{ cause: caught }
		);
	}
	const declaration =
		module && typeof module === 'object' ? Reflect.get(module, 'default') : undefined;
	const metadata =
		declaration && typeof declaration === 'object'
			? Reflect.get(declaration, 'metadata')
			: undefined;
	const history =
		metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'history') : undefined;
	if (history !== undefined && typeof history !== 'boolean') {
		throw new Error(`${modelFile} declares a non-boolean \`history\` metadata value`);
	}
	return history !== false;
}

/** Every tenant collection in the workspace, mapped to its resolved history setting. */
async function tenantCollectionHistory(root: string): Promise<Map<string, boolean>> {
	const structureFile = path.join(root, '.norbital/diagnosis/structure.json');
	const parsed: unknown = JSON.parse(await readFile(structureFile, 'utf8'));
	const collections =
		parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'collections') : undefined;
	if (!Array.isArray(collections)) {
		throw new Error(`${structureFile} carries no collections array`);
	}
	const resolved = new Map<string, boolean>();
	// stupidity:allow A6 -- one dynamic import per collection, ordered so the failing file is named
	for (const entry of collections) {
		if (!entry || typeof entry !== 'object') continue;
		const id = Reflect.get(entry, 'id');
		if (typeof id !== 'string') continue;
		const roles = Reflect.get(entry, 'roles');
		const model = roles && typeof roles === 'object' ? Reflect.get(roles, 'model') : undefined;
		if (typeof model !== 'string') {
			throw new Error(`Collection "${id}" declares no +model.ts, so its history is unknowable`);
		}
		resolved.set(id, await collectionHistoryFlag(path.join(root, model)));
	}
	return resolved;
}

/**
 * Which collections keep a temporal history relation, and which have opted out.
 *
 * Both halves come from the collection definitions — `SystemTableMeta.history` for system
 * collections, `ModelMetadata.history` for tenant ones — so the generator and the runtime post-DDL
 * cannot disagree about a table.
 */
async function collectionTemporality(
	root: string
): Promise<{ temporal: Set<string>; nonTemporal: Set<string> }> {
	const temporal = new Set<string>();
	const nonTemporal = new Set<string>();
	for (const name of SYSTEM_COLLECTION_NAMES) {
		(NON_TEMPORAL_SYSTEM_COLLECTIONS.has(name) ? nonTemporal : temporal).add(name);
	}
	for (const [name, history] of await tenantCollectionHistory(root)) {
		(history ? temporal : nonTemporal).add(name);
	}
	return { temporal, nonTemporal };
}

/**
 * The history relations the existing lineage leaves behind — every one it creates, minus every one
 * it drops, replayed in lineage order.
 *
 * The lineage is the state, so recomputing it each run makes the orphan drop below idempotent: once
 * the drop is committed, the relation is no longer live and nothing is emitted again.
 */
export async function liveHistoryRelations(migrationsRoot: string): Promise<Set<string>> {
	const live = new Set<string>();
	const tags = (await readdir(migrationsRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	// stupidity:allow A6 -- migrations must be replayed in lineage order
	for (const tag of tags) {
		const migrationFile = path.join(migrationsRoot, tag, 'migration.sql');
		if (!existsSync(migrationFile)) continue;
		for (const statement of sqlStatements(await readFile(migrationFile, 'utf8'))) {
			const created = statement.match(
				/_norbital_create_history_table\('[^']*'::regclass,\s*'([^']+)'\)/i
			);
			if (created) {
				live.add(created[1]);
				continue;
			}
			const renamed = statement.match(/^ALTER TABLE "([^"]+)"\s+RENAME TO "([^"]+)"\s*;?$/i);
			if (renamed) {
				if (live.delete(renamed[1])) live.add(renamed[2]);
				continue;
			}
			const dropped = statement.match(/^DROP TABLE (?:IF EXISTS )?"([^"]+)"/i);
			if (dropped) live.delete(dropped[1]);
		}
	}
	return live;
}

/**
 * Drops for history relations whose record table is no longer temporal.
 *
 * `IF EXISTS` because the same migration has to replay against a database provisioned before the
 * history relation existed, and because the test that guards this lineage requires any table absent
 * from the fresh schema to be dropped guardedly.
 */
export function orphanedHistoryDrops(
	live: ReadonlySet<string>,
	temporal: ReadonlySet<string>,
	generatedSql: string
): string[] {
	return [...live]
		.filter((relation) => relation.endsWith(HISTORY_SUFFIX))
		.filter((relation) => !temporal.has(relation.slice(0, -HISTORY_SUFFIX.length)))
		.filter(
			(relation) => !generatedSql.includes(`DROP TABLE IF EXISTS ${quoteIdentifier(relation)}`)
		)
		.sort()
		.map((relation) => `DROP TABLE IF EXISTS ${quoteIdentifier(relation)};`);
}

/** drizzle-kit v1 names a migration `<UTC timestamp>_<name>`; a synthesized one has to match. */
function migrationTag(name: string): string {
	const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
	return `${stamp}_${name}`;
}

/** A lineage entry carrying nothing but history-relation drops. */
async function writeOrphanedHistoryMigration(
	migrationsRoot: string,
	name: string,
	drops: readonly string[]
): Promise<void> {
	if (drops.length === 0) return;
	const tag = migrationTag(name);
	const directory = path.join(migrationsRoot, tag);
	await mkdir(directory, { recursive: true });
	await writeFile(
		path.join(directory, 'migration.sql'),
		`${drops.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`
	);
	// Carry the previous snapshot forward verbatim. Nothing drizzle models has changed — history
	// relations are not drizzle entities — so this is the truthful snapshot for this point in the
	// lineage, and the newest entry has to carry one for the next generation to diff against.
	const previous = (await readdir(migrationsRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && entry.name !== tag)
		.map((entry) => entry.name)
		.sort()
		.at(-1);
	if (previous == null) return;
	const snapshot = path.join(migrationsRoot, previous, 'snapshot.json');
	if (existsSync(snapshot)) await cp(snapshot, path.join(directory, 'snapshot.json'));
}

export async function generatePodMigrations(input: {
	root: string;
	migrationsRoot: string;
	name?: string;
	custom?: boolean;
	hints?: readonly unknown[];
}): Promise<void> {
	const sourceMigrations = path.join(input.root, '.norbital/migrations');
	const schemaFiles = [
		path.join(input.root, '.norbital/generated/registry.ts'),
		platformSystemWorkspaceSchema
	];
	if (input.migrationsRoot !== sourceMigrations) {
		await rm(input.migrationsRoot, { recursive: true, force: true });
		await mkdir(input.migrationsRoot, { recursive: true });
		if (existsSync(sourceMigrations)) {
			await cp(sourceMigrations, input.migrationsRoot, { recursive: true });
		}
	} else {
		await mkdir(input.migrationsRoot, { recursive: true });
	}
	const existingMigrationEntries = new Set(await readdir(input.migrationsRoot));
	const fingerprint = await migrationFingerprint(schemaFiles, input.migrationsRoot);
	if (
		input.name == null &&
		input.custom !== true &&
		JSON.stringify(await readMigrationFingerprint(input.migrationsRoot)) ===
			JSON.stringify(fingerprint)
	) {
		return;
	}

	try {
		const { generateDrizzleMigration } =
			await import('@norbital-ai/platform-utils/tenant_workspace/migrations/generate');
		const { temporal, nonTemporal } = await collectionTemporality(input.root);
		const live = await liveHistoryRelations(input.migrationsRoot);
		await generateDrizzleMigration({
			sourceDir: input.root,
			outDir: input.migrationsRoot,
			name: input.name ?? 'auto',
			custom: input.custom,
			hints: input.hints,
			schemaFiles
		});
		const generatedEntries = (await readdir(input.migrationsRoot))
			.filter((entry) => !existingMigrationEntries.has(entry))
			.filter((entry) => existsSync(path.join(input.migrationsRoot, entry, 'migration.sql')))
			.sort();
		// One invocation of drizzle-kit writes at most one migration. Mirroring only the first of
		// several would leave the rest without their history DDL and still report success, so an
		// unexpected second entry has to stop the build rather than be quietly skipped.
		if (generatedEntries.length > 1) {
			throw new Error(
				`Expected at most one generated migration, got ${generatedEntries.length}: ${generatedEntries.join(', ')}`
			);
		}
		const generated = generatedEntries.at(0);
		if (generated == null) {
			// A collection that only flips `history` produces an empty drizzle diff and no migration
			// directory, because history relations are not drizzle entities. Writing the drops into a
			// lineage entry of their own is what keeps that from succeeding while doing nothing.
			await writeOrphanedHistoryMigration(
				input.migrationsRoot,
				input.name ?? 'auto',
				orphanedHistoryDrops(live, temporal, '')
			);
		} else {
			const migrationFile = path.join(input.migrationsRoot, generated, 'migration.sql');
			const mirrored = mirrorTemporalHistoryDdl(
				await readFile(migrationFile, 'utf8'),
				temporal,
				nonTemporal
			);
			const drops = orphanedHistoryDrops(live, temporal, mirrored);
			await writeFile(migrationFile, [...drops, mirrored].join(`\n${STATEMENT_BREAKPOINT}\n`));
		}
		await writeMigrationFingerprint(
			input.migrationsRoot,
			await migrationFingerprint(schemaFiles, input.migrationsRoot)
		);
	} catch (caught) {
		const commandOutput =
			caught && typeof caught === 'object'
				? `${String(Reflect.get(caught, 'stdout') ?? '')}\n${String(Reflect.get(caught, 'stderr') ?? '')}`
				: '';
		if (
			commandOutput.includes('Interactive prompts require a TTY') ||
			commandOutput.includes('missing_hints')
		) {
			// Loud, not a warning. This branch used to `return`, which reported success: the schema
			// had changed, no migration was written, and everything downstream agreed the build was
			// fine. The compiler emitted the new column, `pod check` passed, the manifest listed it,
			// and the tenant database never got it — so the first query naming that column failed at
			// runtime with a bare "column does not exist", far from the step that skipped.
			//
			// A migration that cannot be generated is a build failure. The workspace author has to
			// resolve it, and the two ways are named here because the error drizzle prints does not
			// say either of them.
			throw new Error(
				'Schema changes need a migration drizzle cannot generate without being asked a question ' +
					'(usually a new NOT NULL column on a table that already has rows, or a rename it cannot ' +
					'tell from a drop-and-add).\n\n' +
					'Resolve it one of two ways:\n' +
					'  • give the column a default, or make it nullable, so the change is unambiguous; or\n' +
					'  • run `pod migrate --custom <name>` and write the migration by hand.\n\n' +
					`drizzle-kit said:\n${commandOutput.trim()}`
			);
		}
		throw caught;
	}
}
