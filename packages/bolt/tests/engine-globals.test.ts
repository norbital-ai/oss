// The engine runs where Node's globals are absent (a tenant cell): a `Buffer` there fails the turn that reaches it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';

const engine = new URL('../src/engine/', import.meta.url).pathname;
const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sources(join(dir, entry.name))
			: entry.name.endsWith('.ts')
				? [join(dir, entry.name)]
				: []
	);

describe('engine globals', () => {
	it('engine source names no Node Buffer (run-js-node defines its own for scripts)', () => {
		const named = sources(engine).filter(
			(file) =>
				!file.endsWith('run-js-node.ts') &&
				/(?<![\w.])Buffer\s*[.(]/.test(readFileSync(file, 'utf8'))
		);
		expect(named).toEqual([]);
	});
});
