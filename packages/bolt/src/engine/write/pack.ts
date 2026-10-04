// Seed packs as hosts read them (rule 70, §7.2): `pack.json` plus `rows/<collection>.jsonl`, written by `bolt build`
// (compiler/artifact/seed.ts). Loading one is a restore into a database with no workspace rows. Here, not in the
// compiler, so any host (bolt start or an adapter) loads packs through `@norbital-ai/bolt/engine` without the build toolchain.
import { EMBED } from '../integrations/embed.ts';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../../decl/values.ts';
import type { EngineManifest, RowData, TenantDb } from '../contracts.ts';
import { seed as restore, MESSAGING_SEED, type SeedPack } from './seed.ts';

export type SeedAsset = { path: string; sha256: string; bytes: number; contentType: string };
export type PackJson = { format: 1; name: string; hash: string; start: readonly string[]; rows: { readonly [collection: string]: number }; assets: readonly SeedAsset[] };
export type Pack = { dir: string; meta: PackJson; rows: { readonly [collection: string]: readonly { readonly [field: string]: Json }[] } };

/** The system collections a pack may seed, in load order. */
export const IDENTITY = ['sys_team', 'sys_user'] as const;
const IDENTITY_COLUMNS: { readonly [t: string]: readonly string[] } = {
	sys_team: ['id', 'name', 'parent'], sys_user: ['id', 'name', 'email', 'kind', 'active', 'admin', 'team', 'phone', 'telegram'],
};

function readRowsFile(file: string): RowData[] {
	// One line at a time: a row may exceed the engine's string limit, and the file certainly does when joined.
	const fd = openSync(file, 'r'), chunk = Buffer.allocUnsafe(1024 * 1024), rows: RowData[] = [];
	let parts: Buffer[] = [], length = 0;
	const take = (line: Buffer) => { if (line.length > 0) rows.push(JSON.parse(line.toString('utf8')) as RowData); };
	try {
		let count;
		while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
			let offset = 0;
			for (let i = 0; i < count; i++) {
				if (chunk[i] !== 10) continue;
				parts.push(Buffer.from(chunk.subarray(offset, i))); length += i - offset;
				take(parts.length === 1 ? parts[0]! : Buffer.concat(parts, length));
				parts = []; length = 0; offset = i + 1;
			}
			if (offset < count) { const rest = Buffer.from(chunk.subarray(offset, count)); parts.push(rest); length += rest.length; }
		}
		if (length > 0) take(parts.length === 1 ? parts[0]! : Buffer.concat(parts, length));
	} finally { closeSync(fd); }
	return rows;
}

export function readPack(dir: string): Pack {
	const meta = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')) as PackJson;
	const rows = Object.fromEntries(Object.keys(meta.rows).map((c) => [c, readRowsFile(join(dir, 'rows', `${c}.jsonl`))]));
	return { dir, meta, rows };
}

/**
 * Rule 70: loads a pack only into a database with no workspace rows (`false` when it had some and nothing changed):
 * identity stages first, then the restore of every collection in relationship order.
 */
export async function loadPack(db: TenantDb, m: EngineManifest, pack: Pack, now: string): Promise<boolean> {
	const tables = [...IDENTITY, ...MESSAGING_SEED, ...Object.keys(m.models)];
	const [probe] = await db.read([{ text: tables.map((t) => `SELECT 1 FROM "${t}"`).join(' UNION ALL ') + ' LIMIT 1', params: [] }]);
	if (probe!.rows.length > 0) return false;
	// ponytail: identity and the restore are two transactions; one, when the restore takes a caller's transaction
	await db.transaction(async (tx) => {
		for (const t of IDENTITY) {
			const rows = pack.rows[t] ?? [];
			if (rows.length === 0) continue;
			const cols = IDENTITY_COLUMNS[t]!.filter((c) => rows.some((r) => r[c] !== undefined));
			// parents before children: a team's parent may come later in the file
			const text = `INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(', ')}) SELECT ${cols.map((c) => `r."${c}"`).join(', ')}
				FROM jsonb_populate_recordset(null::${t}, $1::jsonb) r ON CONFLICT (id) DO NOTHING`;
			if (t === 'sys_team') {
				await tx.query({ text, params: [JSON.stringify(rows.map((r) => ({ ...r, parent: null })))] });
				await tx.query({ text: `UPDATE sys_team t SET parent = r.parent FROM jsonb_populate_recordset(null::sys_team, $1::jsonb) r WHERE t.id = r.id AND r.parent IS NOT NULL`,
					params: [JSON.stringify(rows)] });
			} else await tx.query({ text, params: [JSON.stringify(rows)] });
		}
	});
	const tenant = Object.fromEntries(Object.entries(pack.rows).filter(([c]) => !(IDENTITY as readonly string[]).includes(c))) as SeedPack;
	if (Object.keys(tenant).length > 0) await restore(m, db, tenant, now);
	// a pack writes past the acts that queue `bolt.embed`: seeded rows of a semantic collection would never get a vector
	if (Object.keys(tenant).some((c) => m.models[c]?.search?.semantic !== undefined))
		await db.write({ text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES (gen_random_uuid()::text, $1, '{}'::jsonb, $2::timestamptz, 'updated', 0)`,
			params: [EMBED, now] });
	return true;
}
