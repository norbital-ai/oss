// A page's startup loads the kit's whole static import graph (the shell imports its barrel). The code editor, its
// language packs and the QR encoder load on first use instead: none of them may be reachable by a static import.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const LAZY = [/^@codemirror\//, /^@lezer\//, /^qrcode$/];
// a static `import … from` or `export … from`, not `import type`, `export type` or a dynamic `import(…)`
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

const file = (specifier: string, from: string): string | undefined => {
	if (!specifier.startsWith('.')) return undefined;
	const path = resolve(dirname(from), specifier);
	return path.endsWith('.js') ? path.replace(/\.js$/, '.ts') : path;
};

it('the kit barrel reaches no code editor, language pack or QR encoder by a static import', () => {
	const seen = new Set<string>(),
		reached: string[] = [];
	const pending = [resolve(SOURCE, 'index.ts')];
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (seen.has(next)) continue;
		seen.add(next);
		const text = readFileSync(next, 'utf8');
		const code = next.endsWith('.svelte')
			? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
			: text;
		for (const [, specifier] of code.matchAll(STATIC)) {
			if (specifier === undefined) continue;
			if (LAZY.some((pattern) => pattern.test(specifier))) reached.push(`${next}: ${specifier}`);
			const local = file(specifier, next);
			if (local !== undefined) pending.push(local);
		}
	}
	expect(seen.size).toBeGreaterThan(100);
	expect(reached).toEqual([]);
});
