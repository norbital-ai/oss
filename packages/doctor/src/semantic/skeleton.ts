/**
 * The deterministic reduction behind oversized files in the semantic tier.
 *
 * Embedding models cap context, and a 5 000-line generated file would either blow the budget or
 * crowd out twenty honest files in the same request. The skeleton keeps what decides a file's
 * responsibility — its declaration signatures — and discards what merely fills it. Every step is
 * a pure function of the bytes: no clock, no locale, no set iteration order leaks in, because a
 * skeleton that changed between runs would invalidate index entries the Merkle layer believes are
 * unchanged.
 *
 * Comment stripping uses the compiler's own comment-range scanners over token positions rather
 * than a regex (which cannot tell `//` inside a template literal from a comment) and rather than
 * the printer (whose emit path over parsed files grows quadratically — a 190 KB fixture printed
 * to 3.6 MB, which is disqualifying for a tool that runs per repository). Blank-line collapse and
 * the declaration cap run over plain text afterwards; when the cap engages the text is re-parsed
 * once so slicing offsets belong to the same string that gets emitted.
 */
import ts from 'typescript';

/** Hard ceiling on a skeleton's length, chosen well under every embedding context window. */
export const MAX_SKELETON_CHARS = 48_000;

/** How much of a declaration's body survives capping — enough to recognise, not enough to bloat. */
export const MAX_SKELETON_BODY_CHARS = 400;

const scriptKindFor = (path: string): ts.ScriptKind =>
	/\.(?:tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/**
 * Cut every comment range the scanner reports, in order. Ranges come from the full-start of each
 * node (leading comments, including banners before the first token and anything before EOF) and
 * the end of each node (same-line trailing comments), so every comment sits on some token's
 * radar exactly once.
 */
function stripComments(source: string, parsed: ts.SourceFile): string {
	const cuts: Array<{ pos: number; end: number }> = [];
	const visit = (node: ts.Node): void => {
		for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [])
			cuts.push(range);
		for (const range of ts.getTrailingCommentRanges(source, node.getEnd()) ?? [])
			cuts.push(range);
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	for (const range of ts.getLeadingCommentRanges(
		source,
		parsed.endOfFileToken.getFullStart()
	) ?? [])
		cuts.push(range);

	cuts.sort((left, right) => left.pos - right.pos || left.end - right.end);
	let kept = '';
	let cursor = 0;
	for (const cut of cuts) {
		if (cut.pos < cursor) continue;
		kept += source.slice(cursor, cut.pos);
		cursor = cut.end;
	}
	return kept + source.slice(cursor);
}

/** Collapse blank-line runs into nothing but the separating newline, trimming line ends. */
function collapseBlankLines(stripped: string): string {
	if (stripped.trim() === '') return '';
	const kept = stripped
		.split('\n')
		.map((line) => line.replace(/[ \t]+$/, ''))
		.filter((line) => line !== '');
	return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

/**
 * The first brace that belongs to the statement itself (its body), as opposed to braces nested
 * inside initializers or decorators, which sit deeper in the tree than the statement's direct
 * children. A statement without one — an import, a `type` alias, a `const` with an expression
 * initializer — keeps its whole text as the body and gets no separate header.
 */
function bodyBrace(statement: ts.Statement): ts.Token<ts.SyntaxKind.OpenBraceToken> | undefined {
	let found: ts.Token<ts.SyntaxKind.OpenBraceToken> | undefined;
	ts.forEachChild(statement, (child) => {
		if (
			found === undefined &&
			ts.isToken(child) &&
			child.kind === ts.SyntaxKind.OpenBraceToken
		)
			found = child as ts.Token<ts.SyntaxKind.OpenBraceToken>;
	});
	return found;
}

/**
 * Reduce a source file to at most `MAX_SKELETON_CHARS` characters of declarations, in order,
 * each contributing its signature up to the body brace plus at most
 * `MAX_SKELETON_BODY_CHARS` characters of body.
 */
function cappedDeclarations(path: string, collapsed: string): string {
	const parsed = ts.createSourceFile(
		path,
		collapsed,
		ts.ScriptTarget.Latest,
		true,
		scriptKindFor(path)
	);
	const pieces: Array<string> = [];
	let total = 0;

	for (const statement of parsed.statements) {
		const remaining = MAX_SKELETON_CHARS - total;
		if (remaining <= 0) break;
		const start = statement.getStart(parsed);
		const text = collapsed.slice(start, statement.getEnd());
		const brace = bodyBrace(statement);
		const header =
			brace === undefined ? '' : `${collapsed.slice(start, brace.getStart())}{`;
		const body = brace === undefined ? text : collapsed.slice(brace.getEnd(), statement.getEnd());
		let piece =
			header === ''
				? body.slice(0, MAX_SKELETON_BODY_CHARS)
				: `${header}\n${body.slice(0, MAX_SKELETON_BODY_CHARS)}`;
		if (piece.length > remaining) piece = piece.slice(0, remaining);
		pieces.push(piece);
		total += piece.length + 1;
	}

	return pieces.join('\n');
}

/**
 * The skeleton for one file: comments gone, blank runs collapsed, and — only when the result
 * still exceeds the cap — declarations trimmed to header-plus-400 until it fits. Same bytes in,
 * same string out, always.
 */
export function skeleton(path: string, source: string): string {
	if (source.trim() === '') return '';
	const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFor(path));
	const collapsed = collapseBlankLines(stripComments(source, parsed));
	if (collapsed.length <= MAX_SKELETON_CHARS) return collapsed;
	return cappedDeclarations(path, collapsed);
}
