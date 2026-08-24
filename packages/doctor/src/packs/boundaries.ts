/**
 * Typed boundaries: `any`, casts, and decoding.
 *
 * Ported from the legacy `R*`, `CLONE` and `SCHEMA1` rules. Each is a described shape with the
 * source that must match and the source that must not, both executed by the suite — the legacy
 * detector's equivalents were visitors whose behaviour was only ever asserted indirectly.
 */
import { defineRule } from '../pattern.js';
import { definePack, type Pack, type Rule } from '../rules.js';

const anyInSignature = defineRule({
	id: 'R1',
	severity: 'error',
	summary: 'any in a signature or annotation',
	principles: ['simplicity', 'straightforwardness', 'type-safety'],
	when: ['AnyKeyword'],
	check(node, context) {
		const ts = context.ts;
		// An `any` inside a cast is R3f's business; this rule is about declared surface.
		for (const parent of context.ancestors(node)) {
			if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) return;
			if (
				ts.isParameter(parent) ||
				ts.isPropertySignature(parent) ||
				ts.isPropertyDeclaration(parent) ||
				ts.isVariableDeclaration(parent) ||
				ts.isMethodSignature(parent) ||
				ts.isFunctionLike(parent)
			) {
				context.report(node, 'position=annotation');
				return;
			}
		}
	}
});

const recordUnknownCast = defineRule({
	id: 'R3a',
	severity: 'error',
	summary: 'cast to Record<string, unknown>',
	principles: ['simplicity', 'straightforwardness', 'type-safety'],
	rule: '$VALUE as Record<string, unknown>',
	examples: {
		bad: ['const bag = value as Record<string, unknown>;'],
		good: ['const bag = decode(value);']
	}
});

const doubleCast = defineRule({
	id: 'R3b',
	severity: 'error',
	summary: 'unapproved double cast',
	principles: ['simplicity', 'straightforwardness', 'type-safety'],
	rule: '$VALUE as unknown as $TARGET',
	examples: {
		bad: ['const n = text as unknown as number;'],
		good: ['const n = Number(text);']
	}
});

const unknownCast = defineRule({
	id: 'R3e',
	severity: 'error',
	summary: 'single cast to unknown',
	principles: ['simplicity', 'straightforwardness', 'type-safety'],
	// `a as unknown as T` parses as `(a as unknown) as T`, so the inner node is a genuine
	// `$VALUE as unknown` and a pattern-level `not` on the double cast never sees it. The exclusion
	// has to be stated about the *parent*: this is only a single cast if nothing casts it again.
	rule: {
		all: [
			{ pattern: '$VALUE as unknown' },
			{ not: { inside: { kind: 'AsExpression' }, stopBy: { kind: 'AsExpression' } } }
		]
	},
	examples: {
		bad: ['const opaque = value as unknown;'],
		good: ['const opaque: unknown = value;', 'const n = text as unknown as number;']
	}
});

const anyCast = defineRule({
	id: 'R3f',
	severity: 'error',
	summary: 'explicit cast to any',
	principles: ['simplicity', 'straightforwardness', 'type-safety'],
	rule: '$VALUE as any',
	examples: {
		bad: ['const loose = value as any;'],
		good: ['const loose = value as never;']
	}
});

const parseThenCast = defineRule({
	id: 'R6a',
	severity: 'error',
	summary: 'JSON.parse followed by a cast',
	principles: ['straightforwardness', 'type-safety', 'testability'],
	rule: 'JSON.parse($TEXT) as $TARGET',
	examples: {
		bad: ['const row = JSON.parse(body) as Row;'],
		good: ['const row = decodeRow(body);']
	}
});

const parseUnvalidated = defineRule({
	id: 'R6b',
	severity: 'error',
	summary: 'JSON.parse without visible validation',
	principles: ['straightforwardness', 'type-safety', 'testability'],
	when: ['CallExpression'],
	check(node, context) {
		if (context.calleeName(node) !== 'JSON.parse') return;
		const ts = context.ts;
		// A parse wrapped by a decoder is the validated form; a parse whose result is cast is R6a.
		for (const parent of context.ancestors(node)) {
			if (ts.isAsExpression(parent)) return;
			// `const value: unknown = JSON.parse(text)` is the decoder's own first line, and the
			// compiler enforces the rest: nothing can read an `unknown` until something has proved
			// what it is. That is a stronger guarantee than the callee-name test above, which lets
			// any function with `parse` in its name through.
			if (ts.isVariableDeclaration(parent) && parent.type?.kind === ts.SyntaxKind.UnknownKeyword)
				return;
			if (ts.isCallExpression(parent)) {
				const callee = context.calleeName(parent) ?? '';
				if (/\b(decode|parse|safeParse|validate|schema)/i.test(callee)) return;
			}
		}
		context.report(node, 'api=JSON.parse');
	}
});

const jsonClone = defineRule({
	id: 'CLONE',
	severity: 'error',
	summary: 'JSON stringify/parse clone',
	principles: ['simplicity', 'efficiency', 'no-bloat'],
	rule: 'JSON.parse(JSON.stringify($VALUE))',
	examples: {
		bad: ['const copy = JSON.parse(JSON.stringify(row));'],
		good: ['const copy = structuredClone(row);']
	}
});

const inOperatorDuck = defineRule({
	id: 'R5d',
	severity: 'hint',
	summary: 'in-operator duck typing',
	principles: ['simplicity', 'straightforwardness', 'type-safety'],
	when: ['BinaryExpression'],
	check(node, context) {
		const ts = context.ts;
		const expression = node as import('typescript').BinaryExpression;
		if (expression.operatorToken.kind !== ts.SyntaxKind.InKeyword) return;
		// One `in` narrows a union; a chain of them is reconstructing a shape by hand.
		const chained = context
			.ancestors(node)
			.some(
				(parent) =>
					ts.isBinaryExpression(parent) &&
					(parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
						parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
			);
		if (chained) context.report(node, 'chained=in');
	}
});

const zodImport = defineRule({
	id: 'SCHEMA1',
	severity: 'error',
	summary: 'Zod bypasses the required Effect Schema boundary',
	principles: ['simplicity', 'straightforwardness', 'type-safety', 'no-bloat'],
	when: ['ImportDeclaration'],
	check(node, context) {
		const ts = context.ts;
		const declaration = node as import('typescript').ImportDeclaration;
		if (!ts.isStringLiteral(declaration.moduleSpecifier)) return;
		const specifier = declaration.moduleSpecifier.text;
		if (specifier === 'zod' || specifier.startsWith('zod/'))
			context.report(node, `module=${specifier} prefer=effect/Schema`);
	}
});

export const boundaryRules: ReadonlyArray<Rule> = [
	anyInSignature,
	recordUnknownCast,
	doubleCast,
	unknownCast,
	anyCast,
	parseThenCast,
	parseUnvalidated,
	jsonClone,
	inOperatorDuck,
	zodImport
];

export const boundariesPack: Pack = definePack({
	name: 'norbital/boundaries',
	rules: boundaryRules
});
