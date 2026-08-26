// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { instantFieldAllowsClear } from '../src/data-renderer/time_stamp/timestamp.utils.ts';

const instantRendererSource = readFileSync(
	new URL('../src/data-renderer/time_stamp/timestamp.renderer.svelte', import.meta.url),
	'utf8'
);
const timeViewSource = readFileSync(
	new URL('../src/data-renderer/time_stamp/views/time.view.svelte', import.meta.url),
	'utf8'
);

test('scalar instant fields follow their nullable clear contract', () => {
	assert.equal(instantFieldAllowsClear({ nullable: false }), false);
	assert.equal(instantFieldAllowsClear({ nullable: true }), true);
});

test('instant arrays remain clearable because their empty value is an array, not null', () => {
	assert.equal(instantFieldAllowsClear({ array: true, nullable: false }), true);
	assert.equal(instantFieldAllowsClear({ array: true, nullable: true }), true);
});

test('the instant renderer carries the field clear contract into every date picker path', () => {
	const dayPickers = instantRendererSource.match(/<DateView[\s\S]*?\/>/g) ?? [];
	const dateTimePickers = instantRendererSource.match(/<TimeView[\s\S]*?\/>/g) ?? [];
	const nestedDatePickers = timeViewSource.match(/<DateView[\s\S]*?\/>/g) ?? [];

	assert.equal(dayPickers.length, 2);
	assert.equal(dateTimePickers.length, 1);
	assert.equal(nestedDatePickers.length, 2);
	for (const picker of [...dayPickers, ...dateTimePickers, ...nestedDatePickers]) {
		assert.match(picker, /\{allowClear\}/);
	}
});
