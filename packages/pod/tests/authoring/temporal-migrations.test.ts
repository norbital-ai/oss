import { describe, expect, it } from 'vitest';
import { mirrorTemporalHistoryDdl } from '../../src/lib/vite/migrations.js';

const BREAK = '--> statement-breakpoint';

describe('temporal migration projection', () => {
	it('creates a same-shaped history relation for a temporal table only', () => {
		const sql = [
			'CREATE TABLE "orders" ("norbital_id" uuid PRIMARY KEY, "status" text);',
			'CREATE TABLE "audit_event" ("norbital_id" uuid PRIMARY KEY);'
		].join(`\n${BREAK}\n`);

		expect(mirrorTemporalHistoryDdl(sql, new Set(['orders']))).toBe(
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

		const result = mirrorTemporalHistoryDdl(sql, new Set(['orders']));
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

	it('renames and drops the typed history relation with its collection', () => {
		const sql = [
			'ALTER TABLE "orders" RENAME TO "sales_orders";',
			'ALTER TABLE "sales_orders" ADD COLUMN "reference" text;',
			'DROP TABLE "sales_orders" CASCADE;'
		].join(`\n${BREAK}\n`);

		// Discovery sees only the post-migration name; the transformer recovers the old name by
		// walking the rename backwards.
		const result = mirrorTemporalHistoryDdl(sql, new Set(['sales_orders']));
		expect(result).toContain('ALTER TABLE "orders_history" RENAME TO "sales_orders_history";');
		expect(result).toContain('ALTER TABLE "sales_orders_history" ADD COLUMN "reference" text;');
		expect(result).toContain('DROP TABLE IF EXISTS "sales_orders_history" CASCADE;');
	});
});
