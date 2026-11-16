import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { theme_css, WorkspaceThemeData } from '../src/decl/theme.ts';

it('keeps omitted theme defaults and emits deterministic light/dark overrides', () => {
	expect(theme_css(undefined)).toBe('');
	expect(
		theme_css({ light: { ring: '#124c8c', primary: '#124c8c' }, dark: { primary: '#9cc4ff' } })
	).toBe(':root:not(.dark){--primary:#124c8c;--ring:#124c8c;}\n:root.dark{--primary:#9cc4ff;}\n');
});
it('refuses unknown tokens, declarations, remote resources and invalid theme modes', () => {
	for (const theme of [
		{ light: { typo: '#fff' } },
		{ light: { primary: '#fff;display:none' } },
		{ dark: { primary: '}body{display:none}' } },
		{ light: { 'font-sans': 'url(https://outside.test/font)' } },
		{ dark: { primary: '' } }
	])
		expect(Schema.is(WorkspaceThemeData)(theme)).toBe(false);
	expect(
		Schema.is(WorkspaceThemeData)({
			light: { primary: 'oklch(0.5 0.1 250)', ring: 'var(--primary)' }
		})
	).toBe(true);
});
