import { describe, it, expect } from 'vitest';
import {
	isSafeSqlIdentifier,
	quoteSqlIdentifier
} from '$lib/server/collection/sql-identifier.server.js';

/**
 * There were four of these on the server, under two names, with two different meanings: two
 * escaped embedded quotes and accepted anything, two rejected anything outside the plain
 * identifier shape. Whether a name was safe therefore depended on which file built the statement.
 * These pin the surviving semantic so the escaping variant cannot quietly return.
 */
describe('one SQL identifier rule for the whole server', () => {
	it('accepts ordinary collection and column names', () => {
		for (const name of ['employees', 'norbital_id', '_private', 'a1', 'Payroll_Runs']) {
			expect(isSafeSqlIdentifier(name), name).toBe(true);
			expect(quoteSqlIdentifier(name)).toBe(`"${name}"`);
		}
	});

	/**
	 * The behaviour that differed. The escaping implementations turned each of these into
	 * *correctly quoted* SQL and let it through, so a hostile or malformed name became a surprise
	 * deep inside a query instead of a failure at the boundary. These names come from the tenant
	 * manifest — author-controlled — so being loud beats being clever.
	 */
	it('rejects anything that is not a plain identifier, rather than escaping it', () => {
		for (const name of [
			'has space',
			'quote"inside',
			'semi;colon',
			'dash-ed',
			'1leading',
			'',
			'drop table users'
		]) {
			expect(isSafeSqlIdentifier(name), name).toBe(false);
			expect(() => quoteSqlIdentifier(name), name).toThrow(/Unsafe SQL identifier/);
		}
	});

	it('never returns a string that could close its own quoting', () => {
		// The property the escaping version was reaching for, obtained by refusal instead: whatever
		// comes back has exactly two quote characters, one at each end.
		for (const name of ['employees', 'norbital_row_version']) {
			const quoted = quoteSqlIdentifier(name);
			expect(quoted.split('"')).toHaveLength(3);
			expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true);
		}
	});
});
