import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	liveHistoryRelations,
	mirrorTemporalHistoryDdl,
	orphanedHistoryDrops
} from '../../src/lib/vite/migrations.js';

const BREAK = '--> statement-breakpoint';
const NONE = new Set<string>();

async function lineage(migrations: Readonly<Record<string, string>>): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), 'pod-lineage-'));
	for (const [tag, sql] of Object.entries(migrations)) {
		await mkdir(path.join(root, tag), { recursive: true });
		await writeFile(path.join(root, tag, 'migration.sql'), sql);
	}
	return root;
}

describe('temporal migration projection', () => {
	it('creates a same-shaped history relation for a temporal table only', () => {
		const sql = [
			'CREATE TABLE "orders" ("norbital_id" uuid PRIMARY KEY, "status" text);',
			'CREATE TABLE "audit_event" ("norbital_id" uuid PRIMARY KEY);'
		].join(`\n${BREAK}\n`);

		expect(mirrorTemporalHistoryDdl(sql, new Set(['orders']), new Set(['audit_event']))).toBe(
			[
				'CREATE TABLE "orders" ("norbital_id" uuid PRIMARY KEY, "status" text);',
				`SELECT _norbital_create_history_table('orders'::regclass, 'orders_history');`,
				'CREATE TABLE "audit_event" ("norbital_id" uuid PRIMARY KEY);'
			].join(`\n${BREAK}\n`) + '\n'
		);
	});

	it('mirrors column evolution but not keys or indexes', () => {
		const sql = [
			`ALTER TABLE "orders" ADD COLUMN "reference" text NOT NULL DEFAULT 'unknown';`,
			'ALTER TABLE "orders" ALTER COLUMN "reference" DROP DEFAULT;',
			'ALTER TABLE "orders" RENAME COLUMN "reference" TO "external_reference";',
			'ALTER TABLE "orders" ADD CONSTRAINT "orders_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "user"("norbital_id");',
			'CREATE INDEX "orders_reference_idx" ON "orders" ("external_reference");'
		].join(`\n${BREAK}\n`);

		const result = mirrorTemporalHistoryDdl(sql, new Set(['orders']), NONE);
		expect(result).toContain(
			`ALTER TABLE "orders_history" ADD COLUMN "reference" text NOT NULL DEFAULT 'unknown';`
		);
		expect(result).toContain('ALTER TABLE "orders_history" ALTER COLUMN "reference" DROP DEFAULT;');
		expect(result).toContain(
			'ALTER TABLE "orders_history" RENAME COLUMN "reference" TO "external_reference";'
		);
		expect(result).not.toContain('orders_history_owner_fk');
		expect(result).not.toContain('orders_history_reference_idx');
	});

	it('leaves a collection that has opted out of history untouched', () => {
		const sql = [
			`ALTER TABLE "chat_session" ADD COLUMN "usage_cost_usd" double precision DEFAULT 0 NOT NULL;`,
			`ALTER TABLE "orders" ADD COLUMN "usage_cost_usd" double precision DEFAULT 0 NOT NULL;`
		].join(`\n${BREAK}\n`);

		const result = mirrorTemporalHistoryDdl(
			sql,
			new Set(['orders']),
			new Set(['chat_session', 'chat_turn', 'chat_message'])
		);
		expect(result).not.toContain('chat_session_history');
		expect(result).toContain(
			`ALTER TABLE "orders_history" ADD COLUMN "usage_cost_usd" double precision DEFAULT 0 NOT NULL;`
		);
	});

	it('mirrors stored generated projections into temporal history', () => {
		const sql =
			`ALTER TABLE "orders" ADD COLUMN "source_id" uuid ` +
			`GENERATED ALWAYS AS ((payload ->> 'source_id')::uuid) STORED;`;

		const result = mirrorTemporalHistoryDdl(sql, new Set(['orders']), NONE);
		expect(result).toContain(
			`ALTER TABLE "orders_history" ADD COLUMN "source_id" uuid ` +
				`GENERATED ALWAYS AS ((payload ->> 'source_id')::uuid) STORED;`
		);
	});

	it('renames and drops the typed history relation with its collection', () => {
		const sql = [
			'ALTER TABLE "orders" RENAME TO "sales_orders";',
			'ALTER TABLE "sales_orders" ADD COLUMN "reference" text;',
			'DROP TABLE "sales_orders" CASCADE;'
		].join(`\n${BREAK}\n`);

		// Discovery sees only the post-migration name; the transformer recovers the old name by
		// walking the rename backwards.
		const result = mirrorTemporalHistoryDdl(sql, new Set(['sales_orders']), NONE);
		expect(result).toContain('ALTER TABLE "orders_history" RENAME TO "sales_orders_history";');
		expect(result).toContain('ALTER TABLE "sales_orders_history" ADD COLUMN "reference" text;');
		expect(result).toContain('DROP TABLE IF EXISTS "sales_orders_history" CASCADE;');
	});
});

describe('orphaned temporal history relations', () => {
	it('drops a history relation the lineage still declares for a table that stopped being temporal', async () => {
		const root = await lineage({
			'20260101000000_auto': [
				'CREATE TABLE "chat_session" ("norbital_id" uuid PRIMARY KEY);',
				`SELECT _norbital_create_history_table('chat_session'::regclass, 'chat_session_history');`,
				'CREATE TABLE "orders" ("norbital_id" uuid PRIMARY KEY);',
				`SELECT _norbital_create_history_table('orders'::regclass, 'orders_history');`
			].join(`\n${BREAK}\n`)
		});

		const live = await liveHistoryRelations(root);
		expect(live).toEqual(new Set(['chat_session_history', 'orders_history']));
		expect(orphanedHistoryDrops(live, new Set(['orders']), '')).toEqual([
			'DROP TABLE IF EXISTS "chat_session_history";'
		]);
	});

	it('emits nothing once the drop is in the lineage, or already in the migration being written', async () => {
		const root = await lineage({
			'20260101000000_auto': [
				'CREATE TABLE "chat_session" ("norbital_id" uuid PRIMARY KEY);',
				`SELECT _norbital_create_history_table('chat_session'::regclass, 'chat_session_history');`,
				'CREATE TABLE "chat_turn" ("norbital_id" uuid PRIMARY KEY);',
				`SELECT _norbital_create_history_table('chat_turn'::regclass, 'chat_turn_history');`
			].join(`\n${BREAK}\n`),
			'20260102000000_auto': 'DROP TABLE IF EXISTS "chat_session_history";'
		});

		const live = await liveHistoryRelations(root);
		expect(live).toEqual(new Set(['chat_turn_history']));
		// The remaining orphan is suppressed when the migration being written already drops it —
		// a collection removed outright is dropped by the mirror, not twice.
		expect(orphanedHistoryDrops(live, NONE, 'DROP TABLE IF EXISTS "chat_turn_history";')).toEqual(
			[]
		);
	});
});
