import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SYSTEM_COLLECTIONS } from '../../src/runtime/schema/system-collections.js';

/**
 * Hand-written SQL against a system collection, checked against what that collection declares.
 *
 * This exists because a column was dropped and a writer was left behind. `channel-principal.ts` did
 * `insert into bolt_team ("norbital_id", "name", "inherits")` after `inherits` was removed, so the
 * statement failed with `column "inherits" of relation "bolt_team" does not exist` — and the
 * `Effect.catch` around it turned that into a warning. Every channel in every workspace refused
 * inbound messages, and it reached a person as "the WhatsApp integration does not work", one whole
 * layer away from the cause.
 *
 * Nothing could have caught it. TypeScript does not read template literals, the only test on that
 * module was pure, and 759 tests plus six template typechecks were green when it shipped. It
 * appeared on the first real provision.
 *
 * So the check is textual, over the same source the runtime executes. It is deliberately narrow:
 * it reads the quoted identifiers in an `insert into <system collection> (...)` column list and
 * asserts each is a field that collection declares. It does not parse SQL and does not try to —
 * a column list is the one place this class of drift shows up, and it is the one place a regex can
 * read without guessing.
 */
const SOURCES = [
	'../../src/runtime/channels/channel-principal.ts',
	'../../src/runtime/identity/approver-teams.ts',
	'../../src/runtime/identity/identity.ts'
] as const;

/** Every column a system collection accepts: its declared fields plus the framework's own. */
const declaredColumns = (collectionName: string): ReadonlySet<string> | undefined => {
	const collection = SYSTEM_COLLECTIONS.find((entry) => entry.name === collectionName);
	if (collection === undefined) return undefined;
	return new Set([
		...Object.keys(collection.fields),
		'norbital_id',
		'norbital_created_at',
		'norbital_updated_at'
	]);
};

/** Each `insert into "?<table>"? ( "a", "b", … )` in one source, as a table and its column list. */
const insertColumnLists = (
	source: string
): ReadonlyArray<{ readonly table: string; readonly columns: ReadonlyArray<string> }> =>
	[...source.matchAll(/insert\s+into\s+"?([a-z_]+)"?\s*\(([^)]*)\)/gi)].flatMap((match) => {
		const table = match[1];
		const list = match[2];
		if (table === undefined || list === undefined) return [];
		const columns = [...list.matchAll(/"([^"]+)"/g)].flatMap((column) =>
			column[1] === undefined ? [] : [column[1]]
		);
		return columns.length === 0 ? [] : [{ table, columns }];
	});

describe('hand-written SQL against system collections', () => {
	it('names only columns those collections declare', () => {
		const checked: Array<string> = [];
		for (const relative of SOURCES) {
			const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
			for (const { table, columns } of insertColumnLists(source)) {
				const declared = declaredColumns(table);
				// A table this suite does not own — an authored collection, a scratch table — is not
				// this rule's business, and failing on one would make the rule unmaintainable.
				if (declared === undefined) continue;
				for (const column of columns) {
					checked.push(`${table}.${column}`);
					expect(
						{ column: `${table}."${column}"`, declaredBy: table },
						`${relative} inserts ${table}."${column}", which ${table} does not declare`
					).toEqual({ column: `${table}."${column}"`, declaredBy: table });
					expect(declared.has(column)).toBe(true);
				}
			}
		}
		// The rule is only worth anything if it actually looked at something. Without this a rename
		// of any source file above would empty the loop and leave the suite green and blind.
		expect(checked).toContain('bolt_team.name');
		expect(checked.length).toBeGreaterThanOrEqual(4);
	});
});
