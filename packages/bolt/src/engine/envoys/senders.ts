import { Effect } from 'effect';
// Who an envoy sender is (rule 57, §4.4): the active member whose registered handle is the sender's, by the handle the
// definition's conversation carries — `sys_user.email` for `email`, `sys_user.phone` for `phone` (WhatsApp, a custom chat
// that names phones), `sys_user.telegram` for `telegram`. An administrator sets them (the command center's People). A conversation
// with no handle (Slack, Discord, WeChat) names no member: every sender is unknown.
import type { HandleKind } from '../../decl/runtime/integration.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
const sql = (text: string, ...params: import('../../decl/values.ts').Json[]) => ({ text, params });
/**
 * The comparable form of one address of handle kind `kind`. A WhatsApp JID addresses a device (`6589548277:14@s.whatsapp.net`
 * is companion device 14), so the device suffix goes before the digits are taken; a leading `@` is a sigil, not a
 * domain; handles fold case. An address with no identifying part canonicalises to `''`, which matches nothing.
 */
export function canonicalHandle(kind: HandleKind | null, value: string): string {
	const sigilless = value.startsWith('@') ? value.slice(1) : value;
	if (kind === 'email') return sigilless.trim().toLowerCase();
	const local = sigilless.split('@', 1)[0] ?? sigilless;
	if (kind === 'phone') return (local.split(':', 1)[0] ?? local).replace(/\D/g, '');
	return local.trim().toLowerCase();
}
/** A handle kind's member column in SQL, in its canonical form (the same rule as above). */
const CANONICAL: {
	readonly [K in HandleKind]: string;
} = {
	email: `lower(trim(u.email))`,
	phone: `regexp_replace(split_part(split_part(ltrim(u.phone, '@'), '@', 1), ':', 1), '\\D', '', 'g')`,
	telegram: `lower(trim(split_part(ltrim(u.telegram, '@'), '@', 1)))`
};
/** The active member one registered handle names, or `null` (unknown, ambiguous, or unidentifiable). */
export const memberByHandle = Effect.fn('Agents.memberByHandle')(function* (
	db: TenantDb,
	kind: HandleKind | null,
	handle: string
) {
	const canonical = canonicalHandle(kind, handle);
	if (kind === null || canonical === '') return null;
	const [res] = yield* db.read([
		sql(`SELECT u.id FROM sys_user u WHERE u.active AND ${CANONICAL[kind]} = $1 LIMIT 2`, canonical)
	]);
	return res!.rows.length === 1 ? String(res!.rows[0]!['id']) : null;
});
