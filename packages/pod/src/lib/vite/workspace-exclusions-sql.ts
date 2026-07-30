import type {
	ManifestExclusion,
	NorbitalManifest
} from '@norbital-ai/platform-utils/manifest/types';

/**
 * Dollar-quote tag for the generated DO blocks. Nothing we interpolate may contain it,
 * or the block would terminate early — `assertNoTag` enforces that.
 */
const DO_TAG = '$excl$';

/** Postgres identifiers we are willing to inline unquoted into generated DDL. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertSafeIdentifier(value: string, what: string): void {
	if (!SAFE_IDENTIFIER.test(value)) {
		throw new Error(`Exclusion ${what} "${value}" must be a lowercase snake_case identifier`);
	}
}

function assertNoTag(value: string, what: string): void {
	if (value.includes(DO_TAG)) {
		throw new Error(`Exclusion ${what} may not contain "${DO_TAG}"`);
	}
}

function exclusionDdl(table: string, exclusion: ManifestExclusion): string {
	assertSafeIdentifier(table, 'table');
	assertSafeIdentifier(exclusion.name, 'constraint name');
	if (exclusion.elements.length === 0) {
		throw new Error(`Exclusion "${exclusion.name}" must declare at least one element`);
	}

	const using = exclusion.using ?? 'gist';
	const elements = exclusion.elements
		.map((element) => {
			assertNoTag(element.expr, 'expression');
			assertNoTag(element.with, 'operator');
			return `${element.expr} WITH ${element.with}`;
		})
		.join(', ');
	const where = exclusion.where ? ` WHERE (${exclusion.where})` : '';
	if (exclusion.where) assertNoTag(exclusion.where, 'predicate');

	// Guarded rather than DROP-then-ADD: adding an EXCLUDE constraint builds and validates a
	// GiST index over the whole table, and this runs inside the single deploy transaction. A
	// drop/add pair would pay that cost — and hold that lock — on every deploy.
	return [
		`DO ${DO_TAG}`,
		`BEGIN`,
		`  IF to_regclass('public.${table}') IS NOT NULL`,
		`     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${exclusion.name}') THEN`,
		`    ALTER TABLE ${table} ADD CONSTRAINT ${exclusion.name}`,
		`      EXCLUDE USING ${using} (${elements})${where};`,
		`  END IF;`,
		`END ${DO_TAG};`
	].join('\n');
}

/**
 * Out-of-band DDL for every EXCLUDE constraint declared by the workspace.
 *
 * Drizzle has no entity for exclusion constraints, so they never appear in a migration and
 * `drizzle-kit generate` — which diffs snapshot against snapshot, never against the live
 * database — can never diff them away. This output is appended to `schema-post-ddl.sql`,
 * the same idempotent slot that attaches temporal history and collection triggers.
 *
 * Returns an empty string when the workspace declares none.
 */
export function workspaceExclusionsDdl(manifest: NorbitalManifest): string {
	const blocks: string[] = [];
	for (const [collectionName, collection] of Object.entries(manifest.collections)) {
		for (const exclusion of collection.extensions?.exclusions ?? []) {
			blocks.push(exclusionDdl(collectionName, exclusion));
		}
	}
	if (blocks.length === 0) return '';
	return `-- Workspace EXCLUDE constraints (generated; drizzle cannot express these).\n${blocks.join('\n\n')}\n`;
}
