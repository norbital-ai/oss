// `ctx.files.image/text/table/sheet` (§5.8.1): the engine reads a stored file host-side, over real small files.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/contracts.ts';
import { testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { docs: { description: 'A document', label: 'title', fields: { title: { kind: 'text' }, file: { kind: 'file', accept: ['*/*'], max: '1MiB' } } } },
	relationships: {},
	collections: { docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'file'] } } } },
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
	policies: { ops: { description: 'Ops', grants: { docs: { read: true } }, automations: ['read'] } },
	automations: { read: { description: 'Reads a stored file', runAs: ['ops'], input: { ref: { kind: 'json' }, how: { kind: 'text' } } } },
} as unknown as EngineManifest;

const source = `export default { automation: { read: { body: async ({ ref, how }, ctx) => {
	if (how === 'jpeg') { const small = await ctx.files.image(ref, { jpeg: { maxEdge: 40 } }); return { small, facts: await ctx.files.image(small) }; }
	return ctx.files[how].try(ref);
} } } };`;

const bytes = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url)));

async function read(name: string, mime: string, how: string): Promise<Json> {
	const t = await testWorkspace({ manifest, guest: { source } });
	const admin = t.as(t.admin);
	const up = await admin.upload('docs.file', { name, mime, bytes: bytes(name) });
	if (up.kind !== 'committed') throw new Error('upload failed');
	await admin.act('docs.create', { title: name, file: up.output });
	await t.as(t.member(['ops'])).start('read', { ref: up.output, how }, { id: randomUUID() });
	await t.runDue();
	const [run] = (await t.db.read([{ text: `SELECT state, output, error FROM sys_run`, params: [] }]))[0]!.rows;
	expect(run).toMatchObject({ state: 'succeeded', error: null });
	return run!['output']!;
}

describe('ctx.files.image', () => {
	it('reads a JPEG: size, SHA-256, PDQ and EXIF (taken, GPS, software, camera)', async () => {
		expect(await read('photo.jpg', 'image/jpeg', 'image')).toEqual({
			format: 'jpeg', width: 80, height: 60, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), pdq: expect.stringMatching(/^[0-9a-f]{64}$/),
			exif: { takenAt: expect.stringMatching(/^2026-07-0[34]T/), gps: { lat: expect.closeTo(1.2917, 3), lng: expect.closeTo(103.85, 3) },
				software: 'Adobe Photoshop 25.0', make: 'Acme', model: 'Cam 1' },
		});
	});

	it('reads a PNG and a HEIC, the HEIC with the same picture as its JPEG', async () => {
		expect(await read('photo.png', 'image/png', 'image')).toMatchObject({ format: 'png', width: 32, height: 24, exif: {} });
		const heic = await read('photo.heic', 'image/heic', 'image') as { pdq: string };
		expect(heic).toMatchObject({ format: 'heic', width: 80, height: 60 });
		const jpeg = await read('photo.jpg', 'image/jpeg', 'image') as { pdq: string };
		const bits = (h: string) => [...h].map((d) => parseInt(d, 16).toString(2).padStart(4, '0')).join('');
		const distance = [...bits(heic.pdq)].filter((b, i) => b !== bits(jpeg.pdq)[i]).length;
		expect(distance).toBeLessThanOrEqual(31); // a near-duplicate by PDQ's own threshold
	});

	it('derives a JPEG within maxEdge, stored on the run', async () => {
		const out = await read('photo.heic', 'image/heic', 'jpeg') as { small: Json; facts: Json };
		expect(out.small).toMatchObject({ name: 'photo.jpg', mime: 'image/jpeg' });
		expect(out.facts).toMatchObject({ format: 'jpeg', width: 40, height: 30 });
	});

	it('refuses a file that is no image', async () => {
		expect(await read('items.csv', 'text/csv', 'image')).toMatchObject({ kind: 'upstream', message: expect.stringContaining('JPEG, PNG and HEIC') });
	});
});

describe('ctx.files.text, table, sheet', () => {
	it('reads text as UTF-8 and CSV as rows', async () => {
		expect(await read('items.csv', 'text/csv', 'text')).toBe('name,qty\r\n"Bolt, M8",4\r\n"say ""hi""",2\r\n');
		expect(await read('items.csv', 'text/csv', 'table')).toEqual([['name', 'qty'], ['Bolt, M8', '4'], ['say "hi"', '2']]);
		expect(await read('photo.png', 'image/png', 'text')).toMatchObject({ kind: 'invalid' });
	});

	it('reads an xlsx as a table of strings and as a typed sheet', async () => {
		const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
		expect(await read('items.xlsx', xlsx, 'table')).toEqual([['name', 'qty', 'ok'], ['Bolt, M8', '4', 'true'], ['Nut', '2.5', 'false']]);
		expect(await read('items.xlsx', xlsx, 'sheet')).toEqual([{ name: 'items.xlsx', rows: [['name', 'qty', 'ok'], ['Bolt, M8', 4, true], ['Nut', 2.5, false]] }]);
	});
});
