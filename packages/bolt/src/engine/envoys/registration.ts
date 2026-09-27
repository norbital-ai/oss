// Who an envoy sender is (rule 57, §3.9): a handle linked to a member by a proven claim, and the registration an
// unlinked sender is offered. Ported from today's `envoys/transport-identity.ts` and `envoys.ts` registration.
import type { Json } from '../../decl/values.ts';
import type { Authority, TenantDb } from '../contracts.ts';
import { sql } from '../channels/store.ts';

export const REGISTRATION_MINUTES = 15;

/**
 * The comparable form of one address on one transport. A WhatsApp JID addresses a device (`6589548277:14@s.whatsapp.net`
 * is companion device 14), so the device suffix goes before the digits are taken; a leading `@` is a sigil, not a
 * domain; handles fold case. An address with no identifying part canonicalises to `''`, which matches nothing.
 */
export function canonicalHandle(transport: string, value: string): string {
	const sigilless = value.startsWith('@') ? value.slice(1) : value;
	if (transport === 'email') return sigilless.trim().toLowerCase();
	const local = sigilless.split('@', 1)[0] ?? sigilless;
	if (transport === 'whatsapp') return (local.split(':', 1)[0] ?? local).replace(/\D/g, '');
	return local.trim().toLowerCase();
}
/** The `sys_user` column a transport's handle is stored in, and its canonical form in SQL (the same rule as above). */
const COLUMN: { readonly [transport: string]: { column: string; canonical: string } } = {
	email: { column: 'email', canonical: `lower(trim(u.email))` },
	whatsapp: { column: 'phone', canonical: `regexp_replace(split_part(split_part(ltrim(u.phone, '@'), '@', 1), ':', 1), '\\D', '', 'g')` },
	telegram: { column: 'telegram', canonical: `lower(trim(split_part(ltrim(u.telegram, '@'), '@', 1)))` },
};

/** Another email address a member verified through registration (the claim itself is the record, as today's `user.channels`). */
const VERIFIED_EMAIL = `EXISTS (SELECT 1 FROM bolt_envoy_link l WHERE l.transport = 'email' AND l.status = 'claimed' AND l.sender = $1 AND l.claimed_by = u.id)`;

/** The active member one verified handle names, or `null` (unknown, ambiguous, or unidentifiable). */
export async function memberByHandle(db: TenantDb, transport: string, handle: string): Promise<string | null> {
	const col = COLUMN[transport], canonical = canonicalHandle(transport, handle);
	if (col === undefined || canonical === '') return null;
	const [res] = await db.read([sql(`SELECT u.id FROM sys_user u WHERE u.active AND (${col.canonical} = $1${transport === 'email' ? ` OR ${VERIFIED_EMAIL}` : ''}) LIMIT 2`, canonical)]);
	return res!.rows.length === 1 ? String(res!.rows[0]!['id']) : null;
}

export type Claim = { state: 'ready'; envoy: string; transport: string; handle: string } | { state: 'expired' | 'registered' | 'invalid' };
export type Redemption = { state: 'registered' | 'already_registered'; envoy: string; transport: string; replay: readonly string[] }
	| { state: 'expired' | 'used' | 'conflict' | 'invalid' };

/** The pending claim for this sender, or a new one; one per sender while it lives. */
export async function issueClaim(db: TenantDb, envoy: string, transport: string, handle: string, now: string): Promise<string | null> {
	const sender = canonicalHandle(transport, handle);
	if (sender === '') return null;
	const id = crypto.randomUUID();
	const [row] = (await db.write(sql(`WITH held AS (SELECT id FROM bolt_envoy_link WHERE envoy = $2 AND transport = $3 AND sender = $4 AND status = 'pending'
			AND expires_at > $5::timestamptz LIMIT 1),
		made AS (INSERT INTO bolt_envoy_link (id, envoy, transport, sender, expires_at, created_at)
			SELECT $1, $2, $3, $4, $5::timestamptz + interval '${REGISTRATION_MINUTES} minutes', $5::timestamptz WHERE NOT EXISTS (SELECT 1 FROM held) RETURNING id)
		SELECT coalesce((SELECT id FROM held), (SELECT id FROM made)) AS id`, id, envoy, transport, sender, now))).rows;
	return row!['id'] as string;
}

/** Read-only: safe for mail scanners, link previews and plain GETs. The page shows the handle. */
export async function inspectClaim(db: TenantDb, claim: string, now: string): Promise<Claim> {
	const [res] = await db.read([sql(`SELECT envoy, transport, sender, status, expires_at::text AS expires_at FROM bolt_envoy_link WHERE id = $1`, claim)]);
	const r = res!.rows[0];
	if (r === undefined) return { state: 'invalid' };
	if (r['status'] === 'claimed') return { state: 'registered' };
	if (Date.parse(String(r['expires_at'])) <= Date.parse(now)) return { state: 'expired' };
	return { state: 'ready', envoy: String(r['envoy']), transport: String(r['transport']), handle: String(r['sender']) };
}

/**
 * The signed-in member proves the handle theirs: it is written to their `sys_user` row unless another member holds
 * it, and the claim is consumed, in one statement. An email address is never written over the account's own: the
 * claimed row is the verified additional address, so any member may verify one (P32, as today). `replay` (ticked on the page) names the sender's unregistered
 * messages of the claim's window to admit now; nothing is replayed unless ticked.
 */
export async function redeemClaim(db: TenantDb, claim: string, authority: Authority, now: string, replay: boolean): Promise<Redemption> {
	if (authority.actor.kind !== 'member') return { state: 'invalid' };
	const user = authority.actor.id;
	const [res] = await db.read([sql(`SELECT envoy, transport, sender, status, claimed_by, expires_at::text AS expires_at FROM bolt_envoy_link WHERE id = $1`, claim)]);
	const r = res!.rows[0];
	if (r === undefined || COLUMN[String(r['transport'])] === undefined) return { state: 'invalid' };
	const envoy = String(r['envoy']), transport = String(r['transport']), sender = String(r['sender']);
	if (r['status'] === 'claimed') return r['claimed_by'] === user ? { state: 'already_registered', envoy, transport, replay: [] } : { state: 'used' };
	if (Date.parse(String(r['expires_at'])) <= Date.parse(now)) return { state: 'expired' };
	const col = COLUMN[transport]!;
	const [row] = (await db.write(sql(`WITH taken AS (SELECT u.id FROM sys_user u WHERE u.id <> $2 AND u.active AND (${col.canonical} = $3
			OR ($4 = 'email' AND EXISTS (SELECT 1 FROM bolt_envoy_link l WHERE l.transport = 'email' AND l.status = 'claimed' AND l.sender = $3 AND l.claimed_by = u.id)))),
		mine AS (SELECT u.id FROM sys_user u WHERE u.id = $2 AND ${col.canonical} = $3),
		linked AS (UPDATE sys_user SET ${col.column} = $3, revision = revision + 1 WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM taken)
			AND NOT EXISTS (SELECT 1 FROM mine) AND $4 <> 'email' RETURNING id),
		done AS (UPDATE bolt_envoy_link SET status = 'claimed', claimed_by = $2 WHERE id = $1 AND status = 'pending' AND expires_at > $5::timestamptz
			AND (EXISTS (SELECT 1 FROM linked) OR EXISTS (SELECT 1 FROM mine) OR ($4 = 'email' AND NOT EXISTS (SELECT 1 FROM taken))) RETURNING id)
		SELECT (SELECT count(*) FROM done)::int AS done, (SELECT count(*) FROM mine)::int AS mine, (SELECT count(*) FROM taken)::int AS taken`,
	claim, user, sender, transport, now))).rows;
	if (row!['taken'] !== 0) return { state: 'conflict' };
	if (row!['done'] === 0) return { state: 'invalid' };
	let ids: readonly string[] = [];
	if (replay) {
		const [msgs] = await db.read([sql(`SELECT m.id, m.sender FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation WHERE c.envoy = $1
			AND m.refused = 'unregistered' AND m.created_at > $2::timestamptz - interval '${REGISTRATION_MINUTES} minutes' ORDER BY m.seq`, envoy, now)]);
		// only this sender's messages: the claim proves one handle
		ids = msgs!.rows.filter((x) => canonicalHandle(transport, String(x['sender'] ?? '')) === sender).map((x) => String(x['id'] as Json));
	}
	return { state: row!['mine'] === 0 ? 'registered' : 'already_registered', envoy, transport, replay: ids };
}
