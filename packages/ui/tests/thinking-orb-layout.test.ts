// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
	new URL('../src/thinking-orb/thinking-orb.svelte', import.meta.url),
	'utf8'
);

test('the thinking orb occupies exactly its declared square without an inline baseline', () => {
	const rootStyles = source.match(/\.norbital-thinking-orb\s*\{(?<styles>[\s\S]*?)\n\t\}/)?.groups
		?.styles;
	assert.ok(rootStyles, 'expected root orb styles');
	assert.match(rootStyles, /display:\s*grid;/);
	assert.match(rootStyles, /width:\s*var\(--orb-size\);/);
	assert.match(rootStyles, /height:\s*var\(--orb-size\);/);
	assert.match(rootStyles, /place-items:\s*center;/);
	assert.match(rootStyles, /contain:\s*strict;/);
	assert.doesNotMatch(rootStyles, /display:\s*inline-/);
});

test('the canvas fills that square without contributing its own line box', () => {
	const canvasStyles = source.match(/\n\tcanvas\s*\{(?<styles>[\s\S]*?)\n\t\}/)?.groups?.styles;
	assert.ok(canvasStyles, 'expected canvas styles');
	assert.match(canvasStyles, /display:\s*block;/);
	assert.match(canvasStyles, /width:\s*100%;/);
	assert.match(canvasStyles, /height:\s*100%;/);
});
