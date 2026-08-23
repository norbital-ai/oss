import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { generateDrizzleJson } from 'drizzle-kit/api-postgres';
import { readWorkspaceMigrations } from '../../src/compiler/sync.js';
import { latestSnapshot, writeMigration } from '../../src/compiler/schema-migrations.js';

/**
 * The lineage as the artifact sees it.
 *
 * `bolt migrate` has always written `.norbital/migrations/<tag>/migration.sql`, and `sync` embedded
 * `.norbital/dist` and `assets` and nothing else — so a promoted artifact physically could not carry
 * its own schema history and every `ALTER TABLE` in the lineage stayed on the authoring machine's
 * disk. These cover the reading half: that an entry arrives as its statements in file order, and
 * that generating the next entry cannot disturb the ones already committed.
 */

const lineageRoot = async (
	entries: ReadonlyArray<readonly [tag: string, source: string]>
): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'bolt-lineage-'));
	await Promise.all(
		entries.map(async ([tag, source]) => {
			await mkdir(join(root, '.norbital', 'migrations', tag), { recursive: true });
			await writeFile(join(root, '.norbital', 'migrations', tag, 'migration.sql'), source, 'utf8');
		})
	);
	return root;
};

/**
 * The head of the hr-payroll lineage's newest entry, verbatim.
 *
 * `regime` is jsonb, so dropping a nested member changes no column and drizzle-kit generates nothing
 * for it; the two `UPDATE`s were written by hand and placed above the generated `DROP COLUMN`s so the
 * data is cleaned while the columns it may need still exist. Reordering or normalising them would
 * leave the collection read-only on deploy, which is why the applier is handed file order and never
 * a sorted, deduplicated or re-grouped version of it.
 */
const handAuthored = [
	'-- Hand-authored, ahead of the generated statements below.',
	'UPDATE "jurisdictions" SET "regime" = "regime" - \'rest_breaks\' WHERE "regime" ? \'rest_breaks\';',
	'--> statement-breakpoint',
	'UPDATE "jurisdictions_history" SET "regime" = "regime" - \'rest_breaks\' WHERE "regime" ? \'rest_breaks\';',
	'--> statement-breakpoint',
	'ALTER TABLE "jurisdictions" DROP COLUMN "rounding";',
	'--> statement-breakpoint',
	'ALTER TABLE "jurisdictions_history" DROP COLUMN "rounding";',
	''
].join('\n');

describe('Bolt migration lineage', () => {
	it("reads entries oldest first and keeps each file's statements in the order they were written", async () => {
		const root = await lineageRoot([
			['20260816190844_auto', handAuthored],
			['20260812082031_auto', 'CREATE TABLE "jurisdictions" ();']
		]);
		const lineage = await Effect.runPromise(readWorkspaceMigrations(root));
		expect(lineage.map(({ tag }) => tag)).toEqual(['20260812082031_auto', '20260816190844_auto']);
		// The comment rides with the statement it explains, and both `UPDATE`s precede both `DROP`s.
		expect(lineage[1]?.statements).toEqual([
			'-- Hand-authored, ahead of the generated statements below.\nUPDATE "jurisdictions" SET "regime" = "regime" - \'rest_breaks\' WHERE "regime" ? \'rest_breaks\';',
			'UPDATE "jurisdictions_history" SET "regime" = "regime" - \'rest_breaks\' WHERE "regime" ? \'rest_breaks\';',
			'ALTER TABLE "jurisdictions" DROP COLUMN "rounding";',
			'ALTER TABLE "jurisdictions_history" DROP COLUMN "rounding";'
		]);
	});

	it('reports no lineage for a workspace that has never migrated, rather than failing', async () => {
		expect(
			await Effect.runPromise(
				readWorkspaceMigrations(await mkdtemp(join(tmpdir(), 'bolt-lineage-')))
			)
		).toEqual([]);
	});

	it('reads a current drizzle snapshot back without sending it through the legacy upgrader', async () => {
		const migrationsRoot = await mkdtemp(join(tmpdir(), 'bolt-lineage-'));
		const snapshot = await generateDrizzleJson({});
		await Effect.runPromise(
			writeMigration(migrationsRoot, {
				tag: '20260817000000_baseline',
				statements: [],
				snapshot
			})
		);
		expect(await Effect.runPromise(latestSnapshot(migrationsRoot))).toEqual(snapshot);
	});

	/**
	 * The owner's rule is that Bolt owns migrations but a migration may be edited by hand and is
	 * committed. Generating the next entry therefore has to be strictly additive: a generator that
	 * rewrote or reformatted what is already there would silently undo the ordering above.
	 */
	it('leaves committed entries byte-identical when the next one is generated', async () => {
		const root = await lineageRoot([['20260816190844_auto', handAuthored]]);
		const migrationsRoot = join(root, '.norbital', 'migrations');
		await Effect.runPromise(
			writeMigration(migrationsRoot, {
				tag: '20260817000000_auto',
				statements: ['ALTER TABLE "jurisdictions" ADD COLUMN "levy_basis" text;'],
				snapshot: { id: 'x', prevId: 'y', version: '1', dialect: 'postgresql', ddl: [] } as never
			})
		);
		expect((await readdir(migrationsRoot)).toSorted()).toEqual([
			'20260816190844_auto',
			'20260817000000_auto'
		]);
		expect(
			await readFile(join(migrationsRoot, '20260816190844_auto', 'migration.sql'), 'utf8')
		).toEqual(handAuthored);
	});
});
