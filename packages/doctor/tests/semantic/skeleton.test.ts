/**
 * The skeleton reducer: determinism, comment stripping, blank collapse, and the size cap.
 *
 * Determinism is asserted the only way it can be — identical inputs produce identical strings —
 * alongside structural assertions that each reduction stage actually ran. The oversized fixture is
 * generated with bodies far longer than the 400-character body budget so truncation is observable
 * per declaration rather than inferred from total length alone.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	MAX_SKELETON_BODY_CHARS,
	MAX_SKELETON_CHARS,
	skeleton
} from '../../build/semantic/skeleton.js';

test('comments are stripped and blank runs collapse to single newlines', () => {
	const source = [
		'// leading banner',
		'export const answer = 42;',
		'',
		'',
		'/* block',
		'   comment */',
		'export function greet(name: string): string {',
		'\t// inner note',
		'\treturn `hi ${name}`; // trailing note',
		'}'
	].join('\n');
	const result = skeleton('sample.ts', source);
	assert.equal(result.includes('banner'), false);
	assert.equal(result.includes('block'), false);
	assert.equal(result.includes('inner'), false);
	assert.equal(result.includes('trailing'), false);
	assert.equal(result.includes('\n\n'), false);
	assert.equal(result.includes('export const answer = 42;'), true);
	assert.equal(result.includes('return `hi ${name}`;'), true);
});

test('skeleton output is byte-stable for identical input', () => {
	const source = 'export function f(): number {\n\treturn 1;\n}\n\nexport const g = 2;\n';
	assert.equal(skeleton('stable.ts', source), skeleton('stable.ts', source));
});

test('a file under the cap keeps every declaration', () => {
	const source = ['export function one(): void {}', 'export function two(): void {}'].join('\n');
	const result = skeleton('small.ts', source);
	for (const name of ['one', 'two']) assert.equal(result.includes(`function ${name}`), true);
});

test('an oversized file is capped with headers in order and bodies truncated', () => {
	const declarations: Array<string> = [];
	for (let index = 0; index < 200; index += 1) {
		const pads = Array.from({ length: 40 }, (_, pad) => `\tconst pad${pad} = ${index * 40 + pad};`).join('\n');
		declarations.push(
			[
				`export function generatedFunction${index}(alpha: number, beta: string): string {`,
				`\t// internal note ${index}`,
				pads,
				'\treturn `result-${combined}-${beta}`;',
				'}'
			].join('\n')
		);
	}
	const source = `${declarations.join('\n\n')}\n`;
	assert.equal(source.length > MAX_SKELETON_CHARS, true);

	const first = skeleton('generated.ts', source);
	const second = skeleton('generated.ts', source);
	assert.equal(first, second);
	assert.equal(first.length <= MAX_SKELETON_CHARS, true);

	// Every reduction stage visibly ran.
	assert.equal(first.includes('internal note'), false);
	assert.equal(first.includes('\n\n'), false);

	// Headers survive in order until the cap; each surviving body was cut at the budget, which
	// the absence of any late padding line proves (a full body would carry every pad line).
	const headers = [...first.matchAll(/export function generatedFunction(\d+)\(/g)].map(
		(match) => Number(match[1])
	);
	assert.equal(headers.length > 10, true);
	assert.deepEqual(headers, [...headers].sort((a, b) => a - b));
	assert.equal(headers[headers.length - 1] < 199, true);
	for (const late of ['const pad30 =', 'const pad35 =', 'return `result-'])
		assert.equal(first.includes(late), false);

	// The first declaration's contribution is a header plus at most the body budget.
	const firstPiece = first.slice(0, first.indexOf('export function generatedFunction1('));
	const headerLength = firstPiece.indexOf('{') + 1;
	assert.equal(firstPiece.length <= headerLength + 1 + MAX_SKELETON_BODY_CHARS, true);
});

test('bodyless declarations keep their text within the cap arithmetic', () => {
	const longType = `export type VeryLongUnion = ${Array.from(
		{ length: 300 },
		(_, index) => `"option-${index}"`
	).join(' | ')};`;
	const filler = Array.from(
		{ length: 700 },
		(_, index) => `export function filler${index}(a: number): number {\n\treturn a + ${index};\n}`
	).join('\n\n');
	// The tiny function comes first so it survives the cap; the giant union follows as a
	// declaration without a brace body, contributing only its leading slice.
	const source = `export function tiny(): void {}\n${longType}\n${filler}\n`;
	assert.equal(source.length > MAX_SKELETON_CHARS, true);
	const result = skeleton('types.ts', source);
	assert.equal(result.includes('function tiny'), true);
	assert.equal(result.includes('"option-299"'), false);
});
