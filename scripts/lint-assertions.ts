// The type-assertion lint (audit bug 39, criterion 20): no non-null assertion (`x!`) and no `as` cast but `as const` in
// package source or tests. Decode a boundary or fix the producer instead. Svelte files are read by their `<script>`.
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['node_modules', 'build', 'dist', 'fixtures', '.norbital', '.svelte-kit', '.git']);
const SOURCE = /\.([cm]?ts|svelte)$/;
const SCRIPT = /(<script\b[^>]*>)([\s\S]*?)<\/script>/g;

/** One file's violations, as `path:line message`. */
export const lintAssertions = (path: string, text: string): readonly string[] => {
	const found: string[] = [];
	const scan = (code: string, lineOffset: number) => {
		const file = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 + lineOffset;
		const visit = (node: ts.Node): void => {
			if (ts.isNonNullExpression(node)) found.push(`${path}:${at(node)} a non-null assertion`);
			else if (
				(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
				!(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(file) === 'const')
			)
				found.push(`${path}:${at(node)} a type assertion: decode it or fix the producer`);
			ts.forEachChild(node, visit);
		};
		visit(file);
	};
	if (!path.endsWith('.svelte')) scan(text, 0);
	else
		for (const match of text.matchAll(SCRIPT)) {
			const start = (match.index ?? 0) + (match[1]?.length ?? 0);
			scan(match[2] ?? '', text.slice(0, start).split('\n').length - 1);
		}
	return found;
};

const walk = (root: string, at: string): string[] =>
	readdirSync(at, { withFileTypes: true })
		.filter((entry) => !SKIP.has(entry.name))
		.toSorted((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => {
			const path = join(at, entry.name);
			if (entry.isDirectory()) return walk(root, path);
			if (!SOURCE.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
			return lintAssertions(relative(root, path), readFileSync(path, 'utf8'));
		});

// `node scripts/lint-assertions.ts <dir>...`: the lint step's entry
if (import.meta.main) {
	const found = process.argv.slice(2).flatMap((dir) => walk(process.cwd(), dir));
	process.stderr.write(found.map((line) => `${line}\n`).join(''));
	if (found.length > 0) process.exitCode = 1;
}
