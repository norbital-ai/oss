/// <reference types="node" />
// `@norbital-ai/bolt/type-service` (L-BOLT-079, L-BOLT-1034): hover, definition and a draft check over a workspace's own
// tsconfig; a draft overrides the file on disk and a later call sees the next draft; the LRU drops the oldest workspace.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { typeService } from '../src/tooling/type-service.ts';

const scratch = join(tmpdir(), 'norbital-scratch', `type-service-${randomUUID()}`);
const ws = (name: string) => {
	const root = join(scratch, name);
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022', types: [] }, include: ['src'] }));
	writeFileSync(join(root, 'src/total.ts'), '/** The sum of two amounts. */\nexport function total(a: number, b: number): number { return a + b; }\n');
	writeFileSync(join(root, 'src/use.ts'), "import { total } from './total';\nexport const x = total(1, 2);\n");
	return root;
};
const svc = typeService({ max: 1 });
afterAll(() => { svc.dispose(); rmSync(scratch, { recursive: true, force: true }); });

it('hovers a symbol with its doc comment, and goes to its definition', () => {
	const w = { key: 'a', root: ws('a') };
	const hover = svc.hover(w, { path: 'src/use.ts', line: 2, column: 18 });
	expect(hover?.text).toContain('total(a: number, b: number): number'); // an import hovers as '(alias) total…'
	expect(hover?.documentation).toBe('The sum of two amounts.');
	expect(svc.definition(w, { path: 'src/use.ts', line: 2, column: 18 })).toEqual({ path: 'src/total.ts', line: 2, column: 17 });
	expect(svc.check(w, ['src/use.ts'])).toEqual([]);
});

it('checks a draft without saving it, and drops it when the overlay does', () => {
	const w = { key: 'a', root: join(scratch, 'a') };
	const bad = svc.check({ ...w, overlay: { 'src/use.ts': "import { total } from './total';\nexport const x: string = total(1, 2);\n" } }, ['src/use.ts']);
	expect(bad).toMatchObject([{ path: 'src/use.ts', line: 2, code: 2322 }]);
	expect(svc.check(w, ['src/use.ts'])).toEqual([]);
});

it('keeps at most `max` warm workspaces and refuses a workspace without a tsconfig', () => {
	expect(svc.check({ key: 'b', root: ws('b') }, ['src/use.ts'])).toEqual([]);
	expect(svc.check({ key: 'a', root: join(scratch, 'a') }, ['src/use.ts'])).toEqual([]);   // rebuilt after eviction
	expect(() => svc.check({ key: 'c', root: join(scratch, 'none') }, [])).toThrow(/No tsconfig\.json/);
});
