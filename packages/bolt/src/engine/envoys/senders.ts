// Who an envoy sender is (rule 57, §3.9): the active member whose registered handle is the sender's — `sys_user.email`
// on email, `sys_user.phone` on WhatsApp, `sys_user.telegram` on Telegram. An administrator sets them (Settings → People).
import type { TenantDb } from '../contracts.ts';
import { sql } from '../channels/store.ts';

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
/** A transport's member handle in SQL, in its canonical form (the same rule as above); a transport not here has none. */
const CANONICAL: { readonly [transport: string]: string } = {
	email: `lower(trim(u.email))`,
	whatsapp: `regexp_replace(split_part(split_part(ltrim(u.phone, '@'), '@', 1), ':', 1), '\\D', '', 'g')`,
	telegram: `lower(trim(split_part(ltrim(u.telegram, '@'), '@', 1)))`,
};

/** The active member one registered handle names, or `null` (unknown, ambiguous, or unidentifiable). */
export async function memberByHandle(db: TenantDb, transport: string, handle: string): Promise<string | null> {
	const col = CANONICAL[transport], canonical = canonicalHandle(transport, handle);
	if (col === undefined || canonical === '') return null;
	const [res] = await db.read([sql(`SELECT u.id FROM sys_user u WHERE u.active AND ${col} = $1 LIMIT 2`, canonical)]);
	return res!.rows.length === 1 ? String(res!.rows[0]!['id']) : null;
}
