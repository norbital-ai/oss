import { describe, expect, it } from 'vitest';
import { getColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
	AUTH_MODELS,
	SYSTEM_MODELS,
	SYSTEM_MODEL_TABLES
} from '../../src/authoring/system-models.js';
import { collection } from '../../src/authoring/workspace-schema.js';
import {
	IDENTITY_COLLECTIONS,
	withSystemCollections
} from '../../src/runtime/schema/system-collections.js';

/**
 * Identity is declared once, as collections, and Better Auth is given a view of it.
 *
 * The two used to be separate descriptions of the same tables — a hand-written `create table` per
 * model beside a Drizzle table repeating the columns — and the test here compared them for drift.
 * There is one declaration now. The Drizzle tables consume its builders directly, so the remaining
 * assertion is that the compiled application and database names remain identical.
 */
describe('identity as collections', () => {
	it('declares every model Better Auth is configured to use', () => {
		const declared = new Set(IDENTITY_COLLECTIONS.map((collection) => collection.name));
		for (const table of Object.values(AUTH_MODELS)) expect(declared).toContain(table);
	});

	it.each(['user', 'session', 'account', 'verification', 'auth_config', 'team'])(
		'reserves the runtime-owned %s collection name',
		(name) => {
			expect(() =>
				withSystemCollections({
					collections: [collection({ name, fields: {} })],
					policies: []
				})
			).toThrow(`Workspace collections cannot use runtime-owned names: ${name}`);
		}
	);

	it('maps Better Auth onto the columns those collections actually produce', () => {
		for (const model of Object.values(AUTH_MODELS)) {
			const table = SYSTEM_MODEL_TABLES[model];
			const collection = IDENTITY_COLLECTIONS.find((entry) => entry.name === model);
			expect(collection, `no collection declares ${model}`).toBeDefined();
			const columns = new Set(getTableConfig(table).columns.map((column) => column.name));
			// The platform's own columns, which every collection carries and Better Auth reads under
			// its own names.
			expect(columns).toContain('id');
			for (const field of Object.keys(collection!.fields)) {
				expect(columns, `${model}.${field} is declared but unmapped`).toContain(field);
			}
		}
	});

	it('keeps Drizzle property and database names identical', () => {
		for (const table of Object.values(SYSTEM_MODEL_TABLES)) {
			for (const [property, column] of Object.entries(getColumns(table))) {
				expect(column.name).toBe(property);
			}
		}
	});

	it('puts invitation expiry directly in the greenfield identity schema', () => {
		const invitations = new Set(
			getTableConfig(SYSTEM_MODEL_TABLES.bolt_invitations).columns.map((column) => column.name)
		);
		expect(invitations).toContain('expires_at');
	});

	it('derives system indexes from defineModel metadata', () => {
		for (const [name, model] of Object.entries(SYSTEM_MODELS)) {
			const collection = IDENTITY_COLLECTIONS.find((entry) => entry.name === name);
			if (collection === undefined) continue;
			for (const index of model.metadata?.indexes ?? []) {
				expect(index.columns).toHaveLength(1);
				const [column] = index.columns;
				expect(typeof column).toBe('string');
				if (typeof column === 'string') expect(collection.fields[column]?.indexed).toBe(true);
			}
		}
	});

	it('makes user identity and team names searchable through the standard collection query', () => {
		const searchable = (collectionName: string) =>
			Object.entries(
				IDENTITY_COLLECTIONS.find((collection) => collection.name === collectionName)?.fields ?? {}
			)
				.filter(([, field]) => field.search)
				.map(([name]) => name)
				.toSorted();

		expect(searchable(AUTH_MODELS.user)).toEqual(['email', 'name']);
		expect(searchable('team')).toEqual(['name']);
	});
});
