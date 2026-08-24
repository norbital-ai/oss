import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SYSTEM_COLLECTIONS } from '../../src/runtime/schema/system-collections.js';

/**
 * Runtime data access must travel through the typed persistence composer.
 *
 * This is the regression for the stale `insert into "team" (..., "inherits")` writer that survived
 * the removal of the `inherits` column. Checking that the old SQL named current columns only made
 * the handwritten statement look supported. The supported state is simpler: runtime CRUD against a
 * declared system collection is not handwritten at all, so schema drift becomes a type error.
 */
const SOURCES = [
	'../../src/runtime/identity/approver-teams.ts',
	'../../src/runtime/identity/identity.ts'
] as const;

const systemCollectionPattern = new RegExp(
	`\\b(?:from|into|update|join)\\s+"?(?:${SYSTEM_COLLECTIONS.map(({ name }) => name).join('|')})"?\\b`,
	'i'
);
const dataStatementPattern = /\b(?:select|insert|update|delete)\b/i;

/** Finds authored statement literals in strings and tagged templates alike. */
const rawSystemCollectionStatements = (source: string, fileName: string): ReadonlyArray<string> => {
	const parsed = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	const statements: Array<string> = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isStringLiteralLike(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isTemplateExpression(node)
		) {
			const literal = ts.isTemplateExpression(node) ? node.getText(parsed) : node.text;
			if (dataStatementPattern.test(literal) && systemCollectionPattern.test(literal)) {
				statements.push(literal);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return statements;
};

describe('runtime persistence against system collections', () => {
	it('contains no handwritten data statements', () => {
		for (const relative of SOURCES) {
			const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
			expect(
				rawSystemCollectionStatements(source, relative),
				`${relative} must compose system-collection CRUD through runtime/persistence`
			).toEqual([]);
		}
	});
});
