import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { AUTH_MODELS, AUTH_SCHEMA } from '../../src/runtime/identity/auth.js';
import { authSchema } from '../../src/runtime/identity/auth-tables.js';

/**
 * The two descriptions of identity's tables have to agree.
 *
 * There are two on purpose. `AUTH_SCHEMA` is DDL a host applies to a virgin database before anything
 * can authenticate — the same raw-SQL form every other platform-owned `bolt_*` table takes in
 * `schema-plan.ts` — while the Drizzle tables are what Better Auth reads and writes through. Neither
 * can be derived from the other today, so the risk is drift: a column added to one and not the
 * other compiles, deploys, and fails at the first query that names it.
 *
 * Comparing column names is enough to catch that. Types are already agreed on by construction —
 * every statement here runs against the columns this DDL created — and asserting them would mean
 * restating the type mapping a third time, which is the duplication this guards, not a fix for it.
 */
const columnsInDdl = (sql: string): ReadonlySet<string> => {
	const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
	const names = new Set<string>();
	let depth = 0;
	let current = '';
	for (const character of body) {
		if (character === '(') depth += 1;
		if (character === ')') depth -= 1;
		if (character === ',' && depth === 0) {
			names.add(current.trim());
			current = '';
			continue;
		}
		current += character;
	}
	names.add(current.trim());
	return new Set(
		[...names]
			.map((definition) => definition.trim().split(/\s+/)[0] ?? '')
			// `primary key (a, b)` and friends declare no column of their own.
			.filter((name) => name.length > 0 && !/^(primary|foreign|unique|constraint|check)$/i.test(name))
			.map((name) => name.replace(/^"|"$/g, ''))
	);
};

describe('identity schema', () => {
	for (const [model, table] of Object.entries(AUTH_MODELS)) {
		it(`${model}: the Drizzle table and the bootstrap DDL declare the same columns`, () => {
			const step = AUTH_SCHEMA.find((entry) => entry.sql.includes(`create table if not exists ${table} (`));
			expect(step, `no create-table step for ${table}`).toBeDefined();
			const declared = getTableConfig(authSchema[table as keyof typeof authSchema]);
			expect([...declared.columns.map((column) => column.name)].sort()).toEqual(
				[...columnsInDdl(step!.sql)].sort()
			);
		});
	}
});
