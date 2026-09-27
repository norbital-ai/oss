/// <reference types="node" />
// Rule 7's last stage (L-BOLT-991, 996): `bolt check` and `bolt build` run doctor's four workspace packs, and every
// finding is an author error at its file and line; a reviewed `repository-health:allow` is the one exception.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { doctorFindings } from '../src/cli/build.ts';

const root = join(tmpdir(), 'norbital-scratch', `doctor-gate-${randomUUID()}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const write = (path: string, text: string) => {
	mkdirSync(join(root, path, '..'), { recursive: true });
	writeFileSync(join(root, path), text);
};

it('reports each finding as a diagnostic at its line, and honours a reviewed allowance', () => {
	write('package.json', JSON.stringify({ name: 'ws', private: true, type: 'module' }));
	write('src/lib/label.ts', "export const label = (value: unknown) => (typeof value === 'string' ? value : '');\n");
	write('src/app/home/+home.page.svelte', '<div class="flex gap-2"><span>one</span></div>\n');
	expect(doctorFindings(root).map((d) => `${d.code} ${d.path}:${d.line}`).sort()).toEqual([
		'doctor/GUARD2 src/lib/label.ts:1',
		'doctor/UI27 src/app/home/+home.page.svelte:1',
		'doctor/UI6 src/app/home/+home.page.svelte:1'
	]);
	write(
		'src/lib/label.ts',
		"// repository-health:allow GUARD2 -- the reviewed guard\nexport const label = (value: unknown) => (typeof value === 'string' ? value : '');\n"
	);
	expect(doctorFindings(root).filter((d) => d.path === 'src/lib/label.ts')).toEqual([]);
});

it('rejects hand-rolled polling and a raw event stream in a page (LIVE1, LIVE2; final-sync §4, L-BOLT-996)', () => {
	write('src/app/feed/+feed.page.svelte', `<script lang="ts">
	import { bolt } from '$bolt';
	const timer = setInterval(() => void bolt.read('orders', { all: true }), 5000);
	const source = new EventSource('/events');
</script>
`);
	expect(doctorFindings(root).filter((d) => d.path === 'src/app/feed/+feed.page.svelte').map((d) => `${d.code}:${d.line}`).sort())
		.toEqual(['doctor/LIVE1:3', 'doctor/LIVE2:4']);
});
