// Skills are protocols: numbered rules, no code samples. A skill full of worked examples cost a build 80 KB of reading.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { PLATFORM_SKILLS, platformFile } from '../src/engine/agent/skills.ts';

it('every platform skill is a concise protocol from the canonical source corpus', () => {
	for (const [name, { text }] of Object.entries(PLATFORM_SKILLS)) {
		const [, front = '', body = ''] = text.split(/^---$/m);
		expect(front, name).toMatch(/^description: \S/m);
		expect(text.length, name).toBeLessThan(4_000);
		expect(
			body, name).toMatch(/^1\. \S/m);
		const folder = /^name: (.+)$/m.exec(front)?.[1];
		expect(name).toBe(folder);
		expect(text).toBe(
			readFileSync(new URL(`../../../skills/${folder}/SKILL.md`, import.meta.url), 'utf8')
		);
		for (const file of PLATFORM_SKILLS[name]?.files ?? [])
			expect(platformFile(name, file)).toBe(
				readFileSync(new URL(`../../../skills/${folder}/${file}`, import.meta.url), 'utf8')
			);
	}
});

it('no authoring skill carries a code sample', () => {
	const root = fileURLToPath(new URL('../../../skills', import.meta.url));
	const fenced = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
		(path) => path.endsWith('.md') && /^\s*(```|~~~)/m.test(readFileSync(join(root, path), 'utf8'))
	);
	expect(fenced).toEqual([]);
});
