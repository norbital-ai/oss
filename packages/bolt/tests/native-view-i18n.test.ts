import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@effect/vitest';
import { frameworkText } from '../src/shell/i18n.ts';

test('Chinese framework catalog covers native view messages and retains their placeholders', () => {
	const root = new URL('../../ui/src/', import.meta.url);
	const catalog = frameworkText('zh');
	const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
	let count = 0;
	for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
		if (!/\.(ts|svelte)$/.test(file)) continue;
		const source = readFileSync(new URL(file, root), 'utf8');
		for (const match of source.matchAll(/msg\(bolt,\s*'([^']+)',\s*'((?:\\.|[^'\\])*)'/g)) {
			const key = `ui.${match[1]}`;
			expect(catalog[key], `${file}: ${key}`).toBeTruthy();
			expect(placeholders(catalog[key]!), `${file}: ${key}`).toEqual(placeholders(match[2]!));
			count++;
		}
	}
	expect(count).toBeGreaterThan(0);
	expect(frameworkText('en')).toEqual({});
});
