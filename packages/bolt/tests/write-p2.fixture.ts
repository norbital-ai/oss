// The write area's second workspace: `next-write-fixture` plus keyed tags (a delete guard, a relation-action upsert),
// receipts that `restrict` their order, and keyed people (computed, searchable, a freezing state) for import and erase.
import type { PGlite } from '@electric-sql/pglite';
import type { Json } from '../src/decl/values.ts';
import type { Bindings, Bridge, EngineManifest, Invocation, TenantDb } from '../src/engine/contracts.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import type { Fingerprint } from '../src/engine/write/sql.ts';
import { fingerprinting } from '../src/engine/write/sql.ts';
import { manifest as base } from './write-fixture.ts';

const orders = base.collections.orders!;
export const manifest = {
	...base,
	models: {
		...base.models,
		tags: { description: 'A tag', label: 'name', unique: [{ fields: ['name'] }], fields: { name: { kind: 'text' } } },
		receipts: { description: 'A receipt', label: 'memo', fields: { memo: { kind: 'text' } } },
		people: {
			description: 'A person', label: 'name', key: ['code'], search: { text: ['name'] },
			fields: {
				code: { kind: 'text' }, name: { kind: 'text' }, email: { kind: 'text', optional: true },
				status: { kind: 'state', initial: 'active', states: { active: { to: ['archived'] }, archived: { edit: 'none' } } },
			},
			computed: { shout: { kind: 'text', expr: { upper: { field: 'name' } } } },
		},
	},
	relationships: { ...base.relationships, 'receipts.order': { to: 'orders', inverse: 'receipts' } },
	collections: {
		...base.collections,
		orders: { ...orders, update: { input: { columns: ['title', 'note', 'status'], with: { lines: { create: { columns: ['label', 'amount'] },
			update: { columns: ['label', 'amount'] }, delete: {} }, tags: { link: {}, unlink: {}, upsert: { columns: ['name'] } } } } } },
		tags: { read: { fields: 'all' }, create: { input: { columns: ['name'] } }, delete: { transform: true } },
		receipts: { read: { fields: 'all' }, create: { input: { columns: ['memo', 'order'] } } },
		people: { read: { fields: 'all' }, create: { input: { columns: ['code', 'name', 'email'] } }, update: { input: { columns: ['name', 'email', 'status'] } }, delete: {} },
	},
} as unknown as EngineManifest;

/** A manifest's schema on `db`: the built-in layer and the engine's private tables come with every plan. */
export async function migrate(db: TenantDb, m: EngineManifest = manifest): Promise<void> {
	await applyPlan(db, plan(null, m), { accept: true });
}
export async function open(m: EngineManifest = manifest): Promise<{ pg: PGlite; db: TenantDb }> {
	const x = await openPglite();
	await migrate(x.db, m);
	return x;
}

/** The engine entry's transform bridge (`engine/index.ts`): workspace reads, fingerprinted, one round trip per crossing. */
export function bridgeOn(db: TenantDb, m: EngineManifest = manifest) {
	return (inv: Invocation): Bridge & { tables(): readonly string[]; fingerprints(): readonly Fingerprint[] } => {
		const fp = fingerprinting(db);
		const reads = readEngine({ db: fp.db, manifest: m });
		const tables = new Set<string>();
		const b: Bindings = { now: inv.ctx.now, today: inv.ctx.today, tz: inv.ctx.tz, params: {} };
		return {
			tables: () => [...tables], fingerprints: fp.fingerprints,
			async cross(calls) {
				const batch = calls.flatMap((c) => c.op === 'read' ? [c.read] : []);
				for (const r of batch) tables.add(r.collection);
				return (await reads.run(batch, { as: 'workspace' }, b)).map((value: Json) => ({ ok: true as const, value }));
			},
		};
	};
}
