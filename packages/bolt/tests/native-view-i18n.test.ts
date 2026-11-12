import { required } from './support/required.ts';
import { readFileSync } from 'node:fs';
import { expect, test } from '@effect/vitest';
import { framework_text } from '../src/shell/i18n.ts';

test('Chinese framework catalog covers native view messages and retains their placeholders', () => {
	// `msg(bolt, key)` reads its English fallback from the ui's one MESSAGES table
	const source = readFileSync(new URL('../../ui/src/text/messages.ts', import.meta.url), 'utf8');
	const table = required(source.match(/\nconst MESSAGES = \{\n([\s\S]*?)\n\};/))[1];
	const catalog = framework_text('zh');
	const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
	let count = 0;
	for (const match of required(table).matchAll(/^\t'([^']+)': '((?:\\.|[^'\\])*)',?$/gm)) {
		const key = `ui.${match[1]}`;
		expect(catalog[key], key).toBeTruthy();
		expect(placeholders(required(catalog[key])), key).toEqual(placeholders(required(match[2])));
		count++;
	}
	expect(count).toBe(required(table).split('\n').length);
	expect(framework_text('en')).toEqual({});
});
