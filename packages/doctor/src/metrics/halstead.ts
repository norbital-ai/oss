/**
 * Halstead volume over the tokens of one body.
 *
 * Halstead's software science reduces a body to operators and operands and reports volume =
 * length × log2(vocabulary), where length is total tokens and vocabulary is distinct ones. The
 * metric survives fifty years of criticism because it needs no binding analysis, so this port
 * keeps it that way: a flat token classification, no scope resolution, no attempt to decide what
 * an identifier "means". Determinism over linguistic purity.
 *
 * The mapping table (the whole contract — anything not listed as an operand is an operator):
 *
 * | token class                                              | role     | distinct key |
 * |----------------------------------------------------------|----------|--------------|
 * | identifiers                                              | operand  | source text  |
 * | numeric / string / bigint / regex literals               | operand  | token value  |
 * | template chunks (head, middle, tail, whole)              | operand  | cooked text  |
 * | `this` `super` `true` `false` `null` `undefined`         | operand  | keyword      |
 * | every other keyword (`if`, `const`, `return`, `class`, …)| operator | keyword      |
 * | every punctuation rune (`. => , ; ( ) = == + …`)         | operator | rune(s)      |
 *
 * Two deliberate simplifications, both on the cheap side by design:
 *
 * - All keywords count as operators, not just those "used as" control or unary operators.
 *   Deciding usage needs binding; a uniform rule cannot drift between call sites. The six
 *   data-valued keywords above are the exception because they carry values, not actions.
 * - Type annotations participate as written. A parameter's type annotation contributes its own
 *   tokens; two bodies that differ only in annotations measure differently, which is honest for
 *   a static analyzer reading exactly what the author wrote.
 *
 * Tokens come from the compiler scanner with trivia skipped, so comments never reach the counts,
 * including attached JSDoc.
 */
import ts from 'typescript';

const OPERAND_TOKENS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.Identifier,
	ts.SyntaxKind.NumericLiteral,
	ts.SyntaxKind.BigIntLiteral,
	ts.SyntaxKind.StringLiteral,
	ts.SyntaxKind.RegularExpressionLiteral,
	ts.SyntaxKind.NoSubstitutionTemplateLiteral,
	ts.SyntaxKind.TemplateHead,
	ts.SyntaxKind.TemplateMiddle,
	ts.SyntaxKind.TemplateTail,
	ts.SyntaxKind.ThisKeyword,
	ts.SyntaxKind.SuperKeyword,
	ts.SyntaxKind.TrueKeyword,
	ts.SyntaxKind.FalseKeyword,
	ts.SyntaxKind.NullKeyword,
	ts.SyntaxKind.UndefinedKeyword
]);

export type Halstead = Readonly<{
	/** N1 + N2: every operator and operand occurrence. */
	length: number;
	/** η1 + η2: distinct operators plus distinct operands. */
	vocabulary: number;
	/** length × log2(vocabulary); defined as 0 while vocabulary ≤ 1. */
	volume: number;
}>;

export function halsteadVolume(body: ts.Node): Halstead {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		true,
		ts.LanguageVariant.Standard,
		body.getText()
	);
	const distinctOperators = new Set<string>();
	const distinctOperands = new Set<string>();
	let operatorUses = 0;
	let operandUses = 0;
	for (;;) {
		const kind = scanner.scan();
		if (kind === ts.SyntaxKind.EndOfFileToken) break;
		// getTokenText, not getTokenValue: the value slot goes stale across punctuators, and
		// raw source text (quotes included) is exactly the deterministic key we want anyway.
		const text = scanner.getTokenText();
		if (OPERAND_TOKENS.has(kind)) {
			distinctOperands.add(text);
			operandUses += 1;
		} else {
			distinctOperators.add(text);
			operatorUses += 1;
		}
	}
	const length = operatorUses + operandUses;
	const vocabulary = distinctOperators.size + distinctOperands.size;
	return {
		length,
		vocabulary,
		volume: vocabulary <= 1 ? 0 : length * Math.log2(vocabulary)
	};
}
