// The type-assertion lint (audit bug 39, criterion 20): no non-null assertion (`x!`) and no `as` cast but `as const` in
// source or tests. Decode a boundary or fix the producer instead. Svelte files are read by their `<script>`. `bolt check`
// (a template's CI gate) and the lint step of oss and Colony (`lint.ts`) run it over the files `asserted` names.
import ts from 'typescript';

const SCRIPT = /(<script\b[^>]*>)([\s\S]*?)<\/script>/g;

/** One file's violations: each line and what it asserts. */
export const lintAssertions = (
	path: string,
	text: string
): readonly { readonly line: number; readonly message: string }[] => {
	const found: { line: number; message: string }[] = [];
	const scan = (code: string, lineOffset: number) => {
		const file = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const line = (node: ts.Node) =>
			file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 + lineOffset;
		const visit = (node: ts.Node): void => {
			if (ts.isNonNullExpression(node)) found.push({ line: line(node), message: 'a non-null assertion' });
			else if (
				(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
				!(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(file) === 'const')
			)
				found.push({ line: line(node), message: 'a type assertion: decode it or fix the producer' });
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
