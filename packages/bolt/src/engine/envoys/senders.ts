// Who an envoy sender is: the active member whose registered handle is the sender's, by the handle the
// definition's conversation carries — `sys_user.email` for `email`, `sys_user.phone` for `phone` (WhatsApp, a custom chat
// that names phones), `sys_user.telegram`, `.slack` and `.discord` for theirs. An administrator sets them (the command center's
// People). A conversation with no handle (WeChat, a custom chat) names no member: every sender is unknown.
import { Effect, Schema } from 'effect';
import { sql } from '../db/sql.ts';
import type { HandleKind } from '../../decl/runtime/integration.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { ancestors, teamGraph } from '../identity/graph.ts';
import { memberTeams } from '../identity/teams.ts';
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
	telegram: `lower(trim(split_part(ltrim(u.telegram, '@'), '@', 1)))`,
	slack: `lower(trim(split_part(ltrim(u.slack, '@'), '@', 1)))`,
	discord: `lower(trim(split_part(ltrim(u.discord, '@'), '@', 1)))`
};
/** The active member one registered handle names, or `null` (unknown, ambiguous, or unidentifiable). */
export const memberByHandle = Effect.fn('Agents.memberByHandle')(function* (
	db: TenantDb,
	kind: HandleKind | null,
	handle: string
) {
	const canonical = canonicalHandle(kind, handle);
	if (kind === null || canonical === '') return null;
	const rows = yield* db.rows(
		Schema.Struct({ id: Schema.String }),
		sql(`SELECT u.id FROM sys_user u WHERE u.active AND ${CANONICAL[kind]} = $1 LIMIT 2`, canonical)
	);
	return rows.length === 1 ? (rows[0]?.id ?? null) : null;
});

export type DirectoryMatches = {
	readonly members: readonly string[];
	readonly teams: readonly string[];
};
export const EMPTY_DIRECTORY_MATCHES: DirectoryMatches = { members: [], teams: [] };

/** Resolves all matched active members and their ancestor team ids for one or more peer handles (for listening-scope matching). */
export const directoryMatchesForHandles = Effect.fn('Agents.directoryMatchesForHandles')(function* (
	db: TenantDb,
	workspace: Pick<EngineManifest['workspace'], 'memberships' | 'tz'>,
	kind: HandleKind | null,
	handles: readonly string[],
	now: string
) {
	if (kind === null || handles.length === 0) return EMPTY_DIRECTORY_MATCHES;
	const canonicals = [...new Set(handles.map((h) => canonicalHandle(kind, h)).filter((h) => h !== ''))];
	if (canonicals.length === 0) return EMPTY_DIRECTORY_MATCHES;
	const rows = yield* db.rows(
		Schema.Struct({
			id: Schema.String,
			key: Schema.String,
			teams: Schema.Array(Schema.String)
		}),
		sql(
			`SELECT u.id, ${CANONICAL[kind]} AS key, ${memberTeams(workspace, '$2')} AS teams
			 FROM sys_user u
			 WHERE u.active AND ${CANONICAL[kind]} IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			JSON.stringify(canonicals),
			...(workspace.memberships === undefined ? [] : [now])
		)
	);
	// Ambiguous handles (2+ active members sharing one handle) match nobody, matching `memberByHandle`.
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
	const matched = rows.filter((row) => counts.get(row.key) === 1);
	if (matched.length === 0) return EMPTY_DIRECTORY_MATCHES;
	const graph = yield* teamGraph(db);
	const members = [...new Set(matched.map((row) => row.id))];
	const teams = [
		...new Set(matched.flatMap((row) => row.teams.flatMap((team) => ancestors(graph, team))))
	];
	return { members, teams };
});
