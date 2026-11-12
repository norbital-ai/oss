import { describe, expect, it } from '@effect/vitest';
import { BRIEF_TIMESTAMP, date_time, handle_words, humanise, humanise_word, usd } from '../src/shell/i18n.ts';
import { stepView } from '../src/shell/agent/view.ts';

describe('native shell presentation conventions', () => {
	it('keeps agent Unicode capitals distinct from native ASCII-word label fallback without trimming or collapsing', () => {
		expect(humanise('éclair_task')).toBe('Éclair task');
		expect(humanise_word('éclair_task')).toBe('éclair task');
		expect(humanise('field_ops')).toBe('Field ops');
		expect(humanise_word('field_ops')).toBe('Field ops');
		expect(handle_words('  ID__name.v1  ')).toBe('  ID  name.v1  ');
		expect(humanise('__name.v1__')).toBe('  name.v1  ');
		expect(humanise_word('__name.v1__')).toBe('  name.v1  ');
		expect(stepView('skill', { name: 'éclair_task' }).target).toBe('Éclair task');
	});

	it('retains native date defaults, requested locale/zone, brief precision and invalid-date behavior', () => {
		const at = '2026-10-21T15:05:09Z';
		expect(date_time(at, 'en-GB', { timeZone: 'UTC' })).toBe('21/10/2026, 15:05:09');
		expect(date_time(at, 'en-GB', { timeZone: 'Asia/Singapore' })).toBe('21/10/2026, 23:05:09');
		expect(date_time(at, 'en-GB', { ...BRIEF_TIMESTAMP, timeZone: 'Asia/Singapore' })).toBe('21 Oct 2026, 23:05');
		expect(date_time('not-a-date', 'en-GB')).toBe('Invalid Date');
		expect(() => date_time(at, 'en-GB', { timeZone: 'Invalid/Zone' })).toThrow(RangeError);
	});

	it('keeps settings USD rounding separate from the session cost precision in the runtime locale', () => {
		expect(usd(1.23456)).toBe(usd(1.23));
		expect(usd(1.23456, 4)).toBe(usd(1.2346, 4));
		expect(usd(1.23456, 4)).not.toBe(usd(1.23, 4));
		expect(usd(0.00006)).toBe(usd(0));
		expect(usd(0.00006, 4)).not.toBe(usd(0, 4));
		expect(usd(-1.23456)).toBe(usd(-1.23));
		expect(usd(-1.23456, 4)).toBe(usd(-1.2346, 4));
		expect(usd(1)).toBe(usd(1, 4));
	});

	it('retains the agent-preview extension dialect', () => {
		for (const path of ['file.jsx', 'file.tsx', 'file.mjsx', 'file.mtsx']) {
			expect(stepView('workspace_write', { path, content: '' }).code?.language).toBe('javascript');
		}
		for (const path of ['file.cjs', 'file.cts']) {
			expect(stepView('workspace_write', { path, content: '' }).code?.language).toBe('plaintext');
		}
		for (const path of ['file.ts', 'file.js', 'file.mjs', 'file.svelte']) {
			expect(stepView('workspace_write', { path, content: '' }).code?.language).toBe('javascript');
		}
	});
});
