// A capture is a pack: what `capture_pack` reads of a branch, `restore` loads into an empty one, and a capture of
// that branch is the same rows, files and counts.
import { createHash } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Effect, type FileSystem, type Path } from 'effect';
import type { PackCapture, PackCursor, SeedAsset } from '@norbital-ai/host-api';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { Files } from '../src/engine/ports.ts';
import { pack_asset_loader } from '../src/engine/artifact/read.ts';
import { capture_pack, count_captured, drain, memory_source, type Pack } from '../src/engine/write/pack.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		parties: { description: 'A party', record_label: 'record.name', fields: { name: { kind: 'text' } } },
		orders: {
			description: 'An order',
			record_label: 'record.number',
			fields: {
				number: { kind: 'text' },
				due: { kind: 'date', optional: true },
				total: { kind: 'sum', of: 'lines.amount' },
				status: { kind: 'state', initial: 'open', states: { open: { to: ['done'] }, done: {} } },
				scan: { kind: 'file', accept: ['image/png'], max: '1MiB', optional: true }
			}
		},
		order_lines: {
			description: 'A line',
			record_label: 'record.product',
			fields: { product: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } }
		},
		notes: { description: 'A note', record_label: 'record.body', fields: { body: { kind: 'text' } } }
	},
	relationships: {
		'orders.party': { to: 'parties', inverse: 'orders' },
		'order_lines.order': { to: 'orders', inverse: 'lines', owned: true },
		'notes.about': { to: ['orders', 'parties'], inverse: 'notes' }
	},
	exposures: {},
	integrations: {},
	policies: { sales: { description: 'Sales', grants: {} } },
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const SHA = createHash('sha256').update(PNG).digest('hex');
const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
const P1 = id('a1'), O1 = id('b1'), O2 = id('b2'), L1 = id('c1'), L2 = id('c2'), N1 = id('d1');
const seeded: Pack['rows'] = {
	sys_team: [{ id: 'sales', name: 'Sales', policies: ['sales'] }],
	sys_user: [{ id: 'ann', name: 'Ann', email: 'ann@example.test', team: 'sales' }],
	parties: [{ id: P1, name: 'Acme' }],
	orders: [
		{ id: O1, number: 'A-1', party: P1, due: '2026-12-01', status: 'done', scan: { asset: 'scan.png' } },
		{ id: O2, number: 'A-2', party: P1 }
	],
	order_lines: [
		{ id: L1, order: O1, product: 'Bolt', amount: '1.20' },
		{ id: L2, order: O1, product: 'Nut', amount: '2.05' }
	],
	notes: [{ id: N1, body: 'Call back', about: { model: 'parties', id: P1 } }]
};

const load = (rows: Pack['rows'], assets: readonly SeedAsset[]) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		const loader = yield* pack_asset_loader(
			t.db,
			t.manifest,
			memory_source('capture', rows, [], assets, () => Effect.succeed(PNG)),
			yield* Files,
			t.clock.now()
		);
		expect(yield* drain(loader.step)).toBe('loaded');
		return t.db;
	});
const capture = (db: TenantDbShape) =>
	Effect.gen(function* () {
		const rows: Record<string, { readonly [field: string]: Json }[]> = {};
		const assets = new Map<string, SeedAsset>();
		let cursor: PackCursor | null = null;
		do {
			const page: PackCapture = yield* capture_pack(db, manifest, cursor);
			(rows[page.model] ??= []).push(...page.rows);
			for (const asset of page.assets) assets.set(asset.path, asset);
			cursor = page.next;
		} while (cursor !== null);
		return { rows, assets: [...assets.values()], counts: yield* count_captured(db, manifest) };
	});
const workspace = <A, E>(body: Effect.Effect<A, E, TestWorkspace | Files | FileSystem.FileSystem | Path.Path>) =>
	body.pipe(Effect.provide(TestWorkspace.layer({ manifest })), Effect.scoped);

it.live('a capture restores into an empty branch as the same rows, files and counts', () =>
	Effect.gen(function* () {
		const first = yield* workspace(
			Effect.flatMap(
				load(seeded, [{ path: 'scan.png', sha256: SHA, bytes: PNG.length, content_type: 'image/png' }]),
				capture
			)
		);
		expect(first.counts).toEqual({
			sys_team: 1,
			sys_user: 1,
			sys_integration: 0,
			parties: 1,
			orders: 2,
			order_lines: 2,
			notes: 1
		});
		expect(first.assets).toEqual([
			{ path: `assets/${SHA}/scan.png`, sha256: SHA, bytes: PNG.length, content_type: 'image/png' }
		]);
		const [order] = first.rows['orders'] ?? [];
		expect(order).toMatchObject({
			id: O1,
			number: 'A-1',
			party: P1,
			due: '2026-12-01',
			status: 'done',
			scan: { asset: `assets/${SHA}/scan.png` }
		});
		// a roll-up is the database's: the reload derives it from the lines
		expect(order).not.toHaveProperty('total');
		expect(first.rows['order_lines']?.map((line) => line['amount'])).toEqual(['1.20', '2.05']);
		expect(first.rows['notes']?.[0]?.['about']).toEqual({ model: 'parties', id: P1 });
		expect(first.rows['sys_user']).toEqual([expect.objectContaining({ id: 'ann', team: 'sales' })]);
		const second = yield* workspace(Effect.flatMap(load(first.rows, first.assets), capture));
		expect(second).toEqual(first);
	})
);
