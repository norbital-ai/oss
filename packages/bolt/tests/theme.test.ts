import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { theme_css, WorkspaceThemeData } from '../src/decl/theme.ts';

it('keeps omitted theme defaults and emits deterministic light/dark overrides', () => {
	expect(theme_css(undefined)).toBe('');
	expect(theme_css({ palette: 'warm', accent: 'orange', radius: 'default' })).toBe('');
	expect(
		theme_css({ light: { ring: '#124c8c', primary: '#124c8c' }, dark: { primary: '#9cc4ff' } })
	).toBe(':root:not(.dark){--primary:#124c8c;--ring:#124c8c;}\n:root.dark{--primary:#9cc4ff;}\n');
});

it('compiles high-level palette, accent, and radius knobs with light/dark overrides layered on top', () => {
	const css = theme_css({
		palette: 'neutral',
		accent: 'emerald',
		radius: 'sharp',
		dark: { background: '#05070a' }
	});
	expect(css).toContain(':root:not(.dark){');
	expect(css).toContain('--background:#f4f5f7;');
	expect(css).toContain('--radius:0.5rem;');
	expect(css).toContain('--brand:oklch(0.56 0.15 162);');
	expect(css).toContain(':root.dark{');
	// explicit dark override wins over preset
	expect(css).toContain('--background:#05070a;');
	expect(css).toContain('--brand:oklch(0.73 0.15 162);');
});

it('derives contrast-safe light and dark brand tokens from hex accents', () => {
	const darkHex = theme_css({ accent: '#1467a6' });
	expect(darkHex).toContain('--brand:#1467a6;');
	expect(darkHex).toContain('--brand-foreground:#ffffff;');
	expect(darkHex).toContain('--brand:color-mix(in oklab, #1467a6 78%, white);');

	const lightHex = theme_css({ accent: '#f5d042' });
	expect(lightHex).toContain('--brand:#f5d042;');
	expect(lightHex).toContain('--brand-foreground:#08090a;');
});

it('refuses unknown tokens, invalid presets, declarations, remote resources and invalid theme modes', () => {
	for (const theme of [
		{ palette: 'neon' },
		{ accent: 'purple' },
		{ accent: '#fff' },
		{ accent: '#123456;color:red' },
		{ radius: 'huge' },
		{ light: { typo: '#fff' } },
		{ light: { primary: '#fff;display:none' } },
		{ dark: { primary: '}body{display:none}' } },
		{ light: { 'font-sans': 'url(https://outside.test/font)' } },
		{ dark: { primary: '' } }
	])
		expect(Schema.is(WorkspaceThemeData)(theme)).toBe(false);
	expect(
		Schema.is(WorkspaceThemeData)({
			palette: 'crisp',
			accent: '#2563eb',
			radius: 'soft',
			light: {
				primary: 'oklch(0.5 0.1 250)',
				ring: 'var(--primary)',
				'surface-card': '#fafafa'
			}
		})
	).toBe(true);
});
