// Host source logs only through Effect's logger (one JSON event per line on the host's stdout): never `console`.
// Tenant code's console stays as authored; the browser modules under shell/ log in the person's browser.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const BROWSER = new Set(['shell/public/client.ts']);
const files = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? files(join(dir, entry.name))
			: entry.name.endsWith('.ts')
				? [join(dir, entry.name)]
				: []
	);

it('host source never calls console', () => {
	const scanned = ['engine', 'protocol', 'shell'].flatMap((dir) => files(join(SRC, dir)));
	expect(scanned.length).toBeGreaterThan(100);
	const calls = scanned
		.map((file) => relative(SRC, file))
		.filter((file) => !BROWSER.has(file))
		.flatMap((file) =>
			readFileSync(join(SRC, file), 'utf8')
				.split('\n')
				.flatMap((line, i) =>
					/\bconsole\.(log|info|warn|error|debug|trace)\(/.test(line) ? [`${file}:${i + 1}`] : []
				)
		);
	expect(calls).toEqual([]);
});
