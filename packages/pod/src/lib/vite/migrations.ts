import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SYSTEM_COLLECTION_NAMES } from '@norbital-ai/platform-utils/system/collections';
import {
	migrationFingerprint,
	readMigrationFingerprint,
	writeMigrationFingerprint
} from './migration-fingerprint.js';
const platformSystemWorkspaceSchema = fileURLToPath(
	import.meta.resolve('@norbital-ai/platform-utils/system/workspace-schema')
);

const NON_TEMPORAL_RECORD_TABLES = new Set(['audit_event', 'agent_run_step']);
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

/** Mirror generated record-table column DDL into its typed temporal history relation. */
export function mirrorTemporalHistoryDdl(
	sql: string,
	initialTemporalTables: ReadonlySet<string>
): string {
	const statements = sql
		.split(STATEMENT_BREAKPOINT)
		.map((source) => source.trim())
		.filter(Boolean);
	const temporalTables = new Set(initialTemporalTables);

	// The current workspace inventory contains the post-migration name. Walk renames backwards so
	// a generated old_name -> new_name migration still evolves the already-existing old history
	// relation. A dropped record no longer appears in that inventory; dropping a missing history
	// relation is harmless and keeps both halves of the model together.
	for (const statement of [...statements].reverse()) {
		const rename = statement.match(/^ALTER TABLE "([^"]+)"\s+RENAME TO "([^"]+)"\s*;?$/i);
		if (rename && temporalTables.has(rename[2])) temporalTables.add(rename[1]);
		const drop = statement.match(/^DROP TABLE "([^"]+)"(?:\s+CASCADE)?\s*;?$/i);
		if (drop && !NON_TEMPORAL_RECORD_TABLES.has(drop[1])) temporalTables.add(drop[1]);
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

async function tenantCollectionNames(root: string): Promise<string[]> {
	const source = await readFile(path.join(root, '.norbital/diagnosis/structure.json'), 'utf8');
	const parsed: unknown = JSON.parse(source);
	const collections =
		parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'collections') : undefined;
	if (!Array.isArray(collections)) return [];
	return collections.flatMap((entry) => {
		const id = entry && typeof entry === 'object' ? Reflect.get(entry, 'id') : undefined;
		return typeof id === 'string' ? [id] : [];
	});
}

async function temporalTableNames(root: string): Promise<Set<string>> {
	return new Set(
		[...SYSTEM_COLLECTION_NAMES, ...(await tenantCollectionNames(root))].filter(
			(name) => !NON_TEMPORAL_RECORD_TABLES.has(name)
		)
	);
}

export async function generatePodMigrations(input: {
	root: string;
	migrationsRoot: string;
	name?: string;
	custom?: boolean;
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
		await generateDrizzleMigration({
			sourceDir: input.root,
			outDir: input.migrationsRoot,
			name: input.name ?? 'auto',
			custom: input.custom,
			schemaFiles
		});
		const newMigrationEntries = (await readdir(input.migrationsRoot)).filter(
			(entry) => !existingMigrationEntries.has(entry)
		);
		const temporalTables = await temporalTableNames(input.root);
		for (const entry of newMigrationEntries) {
			const migrationFile = path.join(input.migrationsRoot, entry, 'migration.sql');
			if (!existsSync(migrationFile)) continue;
			const sql = await readFile(migrationFile, 'utf8');
			await writeFile(migrationFile, mirrorTemporalHistoryDdl(sql, temporalTables));
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
