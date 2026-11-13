// Skills are protocols: numbered rules, no code samples. A skill full of worked examples cost a build 80 KB of reading.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { PLATFORM_SKILLS } from '../src/engine/agent/skills.ts';

it('every platform skill is a description and numbered rules, under 4,000 characters', () => {
	for (const [name, { text }] of Object.entries(PLATFORM_SKILLS)) {
		const [, front = '', body = ''] = text.split(/^---$/m);
		expect(front.trim(), name).toMatch(/^description: \S/);
		expect(text.length, name).toBeLessThan(4_000);
		expect(
			body.split('\n').filter((line) => line !== '' && !/^\d+\. \S/.test(line)),
			name
		).toEqual([]);
	}
});

it('no authoring skill carries a code sample', () => {
	const root = fileURLToPath(new URL('../../../skills', import.meta.url));
	const fenced = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
		(path) => path.endsWith('.md') && /^\s*(```|~~~)/m.test(readFileSync(join(root, path), 'utf8'))
	);
	expect(fenced).toEqual([]);
});
