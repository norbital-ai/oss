import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { AUTH_MODELS } from '../../src/runtime/identity/auth.js';
import { authSchema } from '../../src/runtime/identity/auth-tables.js';
import { IDENTITY_COLLECTIONS } from '../../src/runtime/schema/system-collections.js';
import { identitySchemaSteps } from '../../src/compiler/schema-plan.js';

/**
 * Identity is declared once, as collections, and Better Auth is given a view of it.
 *
 * The two used to be separate descriptions of the same tables — a hand-written `create table` per
 * model beside a Drizzle table repeating the columns — and the test here compared them for drift.
 * There is one declaration now, so what is worth asserting is that the mapping still lines up with
 * it: a column renamed on the collection and not in the mapping is a runtime failure no type check
 * would catch, because Drizzle names the property and the column independently on purpose.
 */
describe('identity as collections', () => {
	it('declares every model Better Auth is configured to use', () => {
		const declared = new Set(IDENTITY_COLLECTIONS.map((collection) => collection.name));
		for (const table of Object.values(AUTH_MODELS)) expect(declared).toContain(table);
	});

	it('maps Better Auth onto the columns those collections actually produce', () => {
		for (const [model, table] of Object.entries(authSchema)) {
			const collection = IDENTITY_COLLECTIONS.find((entry) => entry.name === model);
			expect(collection, `no collection declares ${model}`).toBeDefined();
			const columns = new Set(getTableConfig(table).columns.map((column) => column.name));
			// The platform's own columns, which every collection carries and Better Auth reads under
			// its own names.
			expect(columns).toContain('norbital_id');
			for (const field of Object.keys(collection!.fields)) {
				expect(columns, `${model}.${field} is declared but unmapped`).toContain(field);
			}
		}
	});

	it('renders the steps a host applies before anything can authenticate', () => {
		const steps = identitySchemaSteps();
		for (const table of Object.values(AUTH_MODELS)) {
			expect(
				steps.some((step) => step.sql.includes(`create table if not exists "${table}"`)),
				`no create-table step for ${table}`
			).toBe(true);
		}
		// Keyed by the platform's id, which is what a workspace relation points at.
		expect(steps.some((step) => step.sql.includes('norbital_id'))).toBe(true);
	});
});
