import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const boltAgent = fileURLToPath(new URL('../../src/client/ui/agent', import.meta.url));

const listSourceFiles = (directory: string): readonly string[] =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return [...listSourceFiles(path)];
		return /\.(?:svelte|ts|js)$/.test(entry.name) ? [path] : [];
	});

describe('agent UI source audit', () => {
	it('does not import @norbital-ai/pod or export pod', () => {
		const files = listSourceFiles(boltAgent);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const source = readFileSync(file, 'utf8');
			expect(source, file).not.toMatch(/from\s+['"]@norbital-ai\/pod(?:\/[^'"]*)?['"]/);
			expect(source, file).not.toMatch(/import\s*\(\s*['"]@norbital-ai\/pod(?:\/[^'"]*)?['"]/);
			expect(source, file).not.toMatch(/export\s+\{[^}]*\bpod\b/);
			expect(source, file).not.toMatch(/export\s+const\s+pod\b/);
		}
	});
});
