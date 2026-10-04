// Runtime metadata is relational; credentials belong to the host's encrypted secrets store.
import type { Json } from '../../decl/values.ts';
import { BoltError, DbError, type Authority, type Captured, type EngineManifest, type RowData, type TenantDb } from '../contracts.ts';
import { isObj, sql } from './store.ts';

export type ChannelRecord = { id: string; name: string; type: string; owner: string | null; configuration: Json; revision: number };
export type EnvoyRecord = { id: string; name: string; task: string; audience: 'private' | 'public'; policies: string[];
	group_messages: 'disabled' | 'mention_or_reply' | 'all'; delegation: 'disabled' | 'enabled'; triage: Json; active: boolean; revision: number };
export const BUILTIN_CHANNEL_TYPES = ['email', 'whatsapp', 'telegram', 'slack', 'discord', 'wechat'] as const;
const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const id = (x: unknown): x is string => text(x) && /^[a-zA-Z0-9_-]{1,80}$/.test(x);
const invalid = (message: string): never => { throw new BoltError('invalid', 'admission', message); };
const member = (a: Authority) => a.actor.kind === 'member' && !a.actor.external ? a.actor : null;

/** The manifest's messaging maps are an engine projection of records, never authored declarations. */
export async function refreshMessaging(db: TenantDb, m: EngineManifest): Promise<void> {
	const [connections, envoys, bindings] = await db.read([
		sql('SELECT * FROM sys_channel_connection ORDER BY id'), sql('SELECT * FROM sys_envoy WHERE active ORDER BY id'),
		sql('SELECT envoy, channel_connection FROM sys_envoy_channel ORDER BY id'),
	]);
	m.channels = Object.fromEntries(connections!.rows.map((r) => {
		const type = String(r['type']), custom = m.channelTypes?.[type];
		return [String(r['id']), { ...custom, transport: custom?.['transport'] ?? type, name: r['name'], type,
			owner: r['owner'], configuration: r['configuration'], revision: r['revision'] }];
	}));
	m.envoys = Object.fromEntries(envoys!.rows.map((r) => [String(r['id']), { ...r,
		groupMessages: r['group_messages'], channels: bindings!.rows.filter((b) => b['envoy'] === r['id']).map((b) => b['channel_connection']) }]));
}

export async function channelRecords(db: TenantDb, auth: Authority): Promise<ChannelRecord[]> {
	const who = member(auth);
	if (who === null) throw new BoltError('forbidden', 'admission', 'Sign in to manage channel connections.');
	return (await db.read([sql('SELECT * FROM sys_channel_connection WHERE $1 OR owner = $2 ORDER BY name, id', auth.admin, who.id)]))[0]!.rows as unknown as ChannelRecord[];
}

/** One checked operation for shell and tenant UI. Only admins configure envoys or shared connections. */
export async function messagingOp(db: TenantDb, m: EngineManifest, auth: Authority, op: string, input: Json, publish?: (changes: readonly Captured[]) => void | Promise<void>): Promise<Json> {
	const who = member(auth);
	if (who === null) throw new BoltError('forbidden', 'admission', 'Sign in to manage messaging.');
	if (!isObj(input)) return invalid('Messaging configuration must be an object.');
	const key = input['id'] ?? crypto.randomUUID();
	if (!id(key)) return invalid('Use 1–80 letters, digits, underscores or hyphens for the connection identifier.');
	const changes: Captured[] = [];
	const capture = (collection: string, rows: readonly RowData[]) => {
		for (const row of rows) {
			const old = row['old'] as RowData | null, next = row['new'] as RowData | null;
			changes.push({ collection, id: String((next ?? old)!['id']), op: next === null ? 'delete' : old === null ? 'create' : 'update',
				revision: Number(next?.['revision'] ?? Number(old!['revision']) + 1), old, new: next, cause: 'direct' });
		}
	};
	try {
		if (op === 'saveChannel') {
			const [rows] = await db.read([sql('SELECT owner, type FROM sys_channel_connection WHERE id = $1', key)]);
			const before = rows!.rows[0];
			if (!auth.admin && (before !== undefined && before['owner'] !== who.id || input['owner'] !== undefined && input['owner'] !== who.id))
				throw new BoltError('forbidden', 'admission', 'You can only configure your own channel connections.');
			const owner = auth.admin ? input['owner'] ?? before?.['owner'] ?? null : who.id;
			if (owner !== null && !text(owner)) return invalid('Choose a valid connection owner.');
			const type = input['type'] ?? before?.['type'];
			if (!text(type) || !BUILTIN_CHANNEL_TYPES.includes(type as typeof BUILTIN_CHANNEL_TYPES[number]) && m.channelTypes?.[type] === undefined)
				return invalid('Choose an available channel type.');
			if (before !== undefined && type !== before['type']) return invalid('A connection cannot change its type; create another connection.');
			if (!text(input['name'])) return invalid('Name this channel connection.');
			const configuration = input['configuration'] ?? {};
			if (!isObj(configuration)) return invalid('Connection configuration must be an object.');
			const result = await db.write(sql(`INSERT INTO sys_channel_connection (id, name, type, owner, configuration, revision)
				VALUES ($1, $2, $3, $4, $5::jsonb, 1) ON CONFLICT (id) DO UPDATE SET name = excluded.name,
				configuration = excluded.configuration, revision = sys_channel_connection.revision + 1
				WHERE $6 OR sys_channel_connection.owner = $7 RETURNING id, to_jsonb(old) AS old, to_jsonb(new) AS new`, key, input['name'].trim(), type, owner, configuration, auth.admin, who.id));
			capture('sys_channel_connection', result.rows);
			if (result.rows.length === 0) throw new BoltError('forbidden', 'admission', 'This connection belongs to another user.');
		} else if (op === 'saveEnvoy') {
			if (!auth.admin) throw new BoltError('forbidden', 'admission', 'Only an administrator configures envoys.');
			if (!text(input['name']) || typeof input['task'] !== 'string' || input['task'].length > 32_000) return invalid('Supply an envoy name and instructions of at most 32,000 characters.');
			const policies = input['policies'];
			if (!Array.isArray(policies) || policies.length === 0 || policies.some((p) => !text(p) || m.policies[p] === undefined)) return invalid('Choose at least one existing policy for this envoy.');
			const channels = input['channels'];
			if (!Array.isArray(channels) || channels.some((c) => !id(c)) || new Set(channels).size !== channels.length) return invalid('Choose distinct channel connections.');
			const audience = input['audience'] ?? 'private', groups = input['groupMessages'] ?? 'disabled', delegation = input['delegation'] ?? 'disabled';
			if (!['private', 'public'].includes(String(audience)) || !['disabled', 'mention_or_reply', 'all'].includes(String(groups)) || !['disabled', 'enabled'].includes(String(delegation))) return invalid('Invalid envoy audience, group behavior or delegation.');
			const triage = input['triage'] ?? false;
			if (triage !== false && (!isObj(triage) || !['dm', 'group', 'all'].includes(String(triage['scope'] ?? 'all')))) return invalid('Invalid triage configuration.');
			if (input['active'] !== undefined && typeof input['active'] !== 'boolean') return invalid('Active must be a boolean.');
			const result = await db.write(sql(`WITH selected AS (SELECT id FROM sys_channel_connection WHERE id IN (SELECT jsonb_array_elements_text($9::jsonb)) AND owner IS NULL),
				valid AS (SELECT count(*) = jsonb_array_length($9::jsonb) AS ok FROM selected),
				saved AS (INSERT INTO sys_envoy (id, name, task, audience, policies, group_messages, delegation, triage, active, revision)
				SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $10, 1 FROM valid WHERE ok
				ON CONFLICT (id) DO UPDATE SET name = excluded.name, task = excluded.task, audience = excluded.audience,
				policies = excluded.policies, group_messages = excluded.group_messages, delegation = excluded.delegation,
				triage = excluded.triage, active = excluded.active, revision = sys_envoy.revision + 1 RETURNING id, to_jsonb(old) AS old, to_jsonb(new) AS new),
				removed AS (DELETE FROM sys_envoy_channel WHERE envoy = $1 AND channel_connection NOT IN (SELECT id FROM selected) AND EXISTS (SELECT 1 FROM saved) RETURNING id, to_jsonb(old) AS old, NULL::jsonb AS new),
				attached AS (INSERT INTO sys_envoy_channel (id, envoy, channel_connection, revision)
				SELECT $1 || ':' || s.id, $1, s.id, 1 FROM selected s WHERE EXISTS (SELECT 1 FROM saved)
				ON CONFLICT (id) DO NOTHING RETURNING id, NULL::jsonb AS old, to_jsonb(new) AS new)
				SELECT 'sys_envoy' AS collection, * FROM saved UNION ALL SELECT 'sys_envoy_channel', * FROM removed UNION ALL SELECT 'sys_envoy_channel', * FROM attached`, key, input['name'].trim(), input['task'], audience, policies, groups, delegation, triage, channels, input['active'] ?? true)).then((r) => {
				if (r.rows.length === 0) invalid('Envoys can attach only existing workspace-owned connections.');
				return r;
			});
			for (const row of result.rows) capture(String(row['collection']), [row]);
		} else if (op === 'deleteEnvoy') {
			if (!auth.admin) throw new BoltError('forbidden', 'admission', 'Only an administrator deletes envoys.');
			const result = await db.write(sql(`WITH removed AS (DELETE FROM sys_envoy_channel WHERE envoy = $1 RETURNING id, to_jsonb(old) AS old, NULL::jsonb AS new),
				deleted AS (DELETE FROM sys_envoy WHERE id = $1 AND (SELECT count(*) FROM removed) >= 0 RETURNING id, to_jsonb(old) AS old, NULL::jsonb AS new)
				SELECT 'sys_envoy' AS collection, * FROM deleted UNION ALL SELECT 'sys_envoy_channel', * FROM removed`, key));
			for (const row of result.rows) capture(String(row['collection']), [row]);
		} else if (op === 'deleteChannel') {
			const r = await db.write(sql(`DELETE FROM sys_channel_connection WHERE id = $1 AND ($2 OR owner = $3)
				AND NOT EXISTS (SELECT 1 FROM sys_envoy_channel WHERE channel_connection = $1) RETURNING id, to_jsonb(old) AS old, NULL::jsonb AS new`, key, auth.admin, who.id));
			capture('sys_channel_connection', r.rows);
			if (r.rows.length === 0) invalid('Detach this connection from its envoy first, or check that you own it.');
		} else return invalid('Unknown messaging operation.');
	} catch (e) {
		if (e instanceof DbError && e.sqlstate === '23505') return invalid('This connection is already attached to another envoy.');
		throw e;
	}
	await refreshMessaging(db, m);
	await publish?.(changes);
	return { id: key };
}

export const envoyOn = (m: EngineManifest, channel: string): [string, RowData] | undefined =>
	Object.entries(m.envoys).find(([, e]) => Array.isArray(e['channels']) && e['channels'].includes(channel)) as [string, RowData] | undefined;
