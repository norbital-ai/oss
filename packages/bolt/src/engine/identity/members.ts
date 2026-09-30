// Member administration (rules 38b, 38c): invitations, the admin flag with its `lastAdmin` guard, (de)activation,
// teams and assignments, API keys. Every verb is admin-only, never grantable, and one write statement.
import { timingSafeEqual } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import { under } from '../../protocol/wire.ts';
import { BoltError, callPort, DbError, LIMITS, type Authority, type EngineManifest, type Lock, type MembershipPort } from '../contracts.ts';
import { ADDRESS_HINT, digits, parseAddress, type Address } from './address.ts';
import {
	acceptPieces, announceMembership, by, MEMBERSHIP, historyOf, IMAGES, jsonb, newId, ok, projection, refuse, requireAdmin, sha256, SIGNUP_KEY, stmt, type IdentityHost, type Invitation, type Result
} from './session.ts';

const INVITE_MS = 7 * 24 * 3_600_000;
/** Serializes every change to who is an active admin, so the count assert sees the other writer (rule 38c race). */
const ADMINS: Lock = { advisory: ['sys_user.admins'] };

async function write<T>(h: IdentityHost, s: ReturnType<typeof stmt>, text: string, lock?: Lock, read?: (row: { readonly [c: string]: Json } | undefined) => Result<T>): Promise<Result<T>> {
	try {
		const out = await h.db.write({ text, params: s.params }, lock);
		if (s.params.includes(MEMBERSHIP)) announceMembership(h); // the statement queued `bolt.membership` (§5.11.3)
		return read === undefined ? ok(null as T) : read(out.rows[0]);
	} catch (e) {
		if (e instanceof DbError && e.sqlstate === '23514') return refuse('check', 'A member rule refused the change (only staff can be administrators).');
		throw e;
	}
}
const unknownPolicy = (m: EngineManifest, policies: readonly string[]) => policies.find((p) => m.policies[p] === undefined);

// ── invitations (rule 38b) ──
/** An invitation names its person by email, by mobile number (international form), or both; the link goes to each. */
export type InviteInput = { email?: string; phone?: string; team?: string; assignments?: { policy: string; scope?: { collection: string; id: string } }[];
	external?: boolean; party?: { collection: string; id: string } };

/** Sends an invitation's link to each address it names: an email by the mail port, a number by the SMS port. */
async function deliver(h: IdentityHost, to: readonly Address[], id: string): Promise<void> {
	const link = under(h.publicUrl, `/invite/${id}`);
	for (const a of to)
		if (a.kind === 'email')
			await callPort('email', h.mail, LIMITS.callMs.other, (mail, signal) =>
				mail.send('email', { to: a.value, subject: 'You are invited to a workspace', text: `Accept your invitation: ${link}`, link }, signal));
		else
			await callPort('sms', h.sms, LIMITS.callMs.other, (sms, signal) =>
				sms.send('sms', { to: a.value, text: `You are invited to a workspace. Accept your invitation: ${link}` }, signal));
}
/** The addresses an invitation names, parsed; `null` when one is malformed or there is none. */
function addressesOf(input: { email?: string | null; phone?: string | null }): Address[] | null {
	const typed = [input.email, input.phone].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
	const parsed = typed.map(parseAddress);
	return parsed.length === 0 || parsed.some((a) => a === null) || parsed.filter((a) => a!.kind === 'email').length > 1
		|| parsed.filter((a) => a!.kind === 'phone').length > 1 ? null : parsed as Address[];
}

/** Admin-only; never sets `admin`. The notice's link is built from the host's public origin (§5.11.6). */
export async function invite(h: IdentityHost, m: EngineManifest, auth: Authority, input: InviteInput): Promise<Result<{ id: string }>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const to = addressesOf(input);
	if (to === null) return refuse('check', ADDRESS_HINT);
	const email = to.find((a) => a.kind === 'email')?.value ?? null, phone = to.find((a) => a.kind === 'phone')?.value ?? null;
	const assignments = input.assignments ?? [];
	const bad = unknownPolicy(m, assignments.map((a) => a.policy));
	if (bad !== undefined) return refuse('notFound', `There is no policy '${bad}'.`);
	const id = newId(), now = h.now(), s = stmt();
	const r = await write(h, s, `WITH ins AS (INSERT INTO sys_invitation (id, email, phone, team, assignments, external, party, invited_by, expires_at)
VALUES (${s.p(id)}, ${s.p(email)}, ${s.p(phone)}, ${s.p(input.team ?? null)}, ${s.p(JSON.stringify(assignments))}::jsonb, ${s.p(input.external === true)},
	${s.p(jsonb(input.party))}::jsonb, ${s.p(auth.actor.kind === 'member' ? auth.actor.id : null)}, ${s.p(new Date(now.getTime() + INVITE_MS).toISOString())}::timestamptz) ${IMAGES}),
${historyOf(s, 'sys_invitation', 'ins', now, by(auth))} SELECT 1`);
	if (!r.ok) return r;
	await deliver(h, to, id);
	return ok({ id });
}

export type InvitationView = { email: string | null; phone: string | null; team: string | null; external: boolean; status: 'open' | 'accepted' | 'revoked' | 'expired' };
/** Inspecting the link never consumes or changes it. */
export async function inspectInvitation(h: IdentityHost, id: string): Promise<InvitationView | null> {
	const [rows] = await h.db.read([{ text: 'SELECT email, phone, team, external, expires_at, accepted_at, revoked_at FROM sys_invitation WHERE id = $1', params: [id] }]);
	const r = rows!.rows[0] as { email: string | null; phone: string | null; team: string | null; external: boolean; expires_at: string; accepted_at: string | null; revoked_at: string | null } | undefined;
	if (r === undefined) return null;
	const status = r.accepted_at !== null ? 'accepted' : r.revoked_at !== null ? 'revoked' : Date.parse(r.expires_at) <= h.now().getTime() ? 'expired' : 'open';
	return { email: r.email, phone: r.phone, team: r.team, external: r.external, status };
}

/**
 * Only a session for an invited address (the member's email or their number) accepts; the member's team, kind, party and assignments land in one act. An
 * expired, revoked or used invitation refuses `expired` and is left as it was.
 */
export async function acceptInvitation(h: IdentityHost, session: { user: string }, id: string): Promise<Result<null>> {
	const now = h.now();
	const [invs, users] = await h.db.read([
		{ text: 'SELECT id, email, phone, team, assignments, external, party, expires_at, accepted_at, revoked_at FROM sys_invitation WHERE id = $1', params: [id] },
		{ text: 'SELECT email, phone FROM sys_user WHERE id = $1 AND active', params: [session.user] },
	]);
	const inv = invs!.rows[0] as (Invitation & { expires_at: string; accepted_at: string | null; revoked_at: string | null }) | undefined;
	const member = users!.rows[0] as { email: string | null; phone: string | null } | undefined;
	if (inv === undefined) return refuse('notFound', 'No such invitation.');
	const sameEmail = member?.email != null && inv.email !== null && member.email.toLowerCase() === inv.email.toLowerCase();
	const samePhone = member?.phone != null && inv.phone !== null && digits(member.phone) === digits(inv.phone);
	if (!sameEmail && !samePhone) return refuse('forbidden', 'This invitation is for another address.');
	if (inv.accepted_at !== null || inv.revoked_at !== null || Date.parse(inv.expires_at) <= now.getTime()) return refuse('expired', 'This invitation has expired.');
	const s = stmt();
	return write(h, s, `WITH ${acceptPieces(s, inv, session.user, now, 'true', false)}${projection(h, s, 'member')} SELECT (SELECT count(*) FROM member)::int AS n`, undefined,
		(r) => r?.n === 1 ? ok(null) : refuse('expired', 'This invitation has expired.'));
}

export async function revokeInvitation(h: IdentityHost, auth: Authority, id: string): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt();
	return write(h, s, `WITH u AS (UPDATE sys_invitation SET revoked_at = ${s.p(h.now().toISOString())}::timestamptz, revision = revision + 1
WHERE id = ${s.p(id)} AND accepted_at IS NULL AND revoked_at IS NULL ${IMAGES}), ${historyOf(s, 'sys_invitation', 'u', h.now(), by(auth))} SELECT id FROM u`, undefined,
		(r) => r === undefined ? refuse('notFound', 'No open invitation.') : ok(null));
}

/**
 * `sys_invitation.resend` (rule 38c): an invitation not yet accepted or revoked (expired included) gets a fresh 7-day
 * expiry and its notice again.
 */
export async function resendInvitation(h: IdentityHost, auth: Authority, id: string): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt(), now = h.now();
	const r = await write(h, s, `WITH u AS (UPDATE sys_invitation SET expires_at = ${s.p(new Date(now.getTime() + INVITE_MS).toISOString())}::timestamptz, revision = revision + 1
WHERE id = ${s.p(id)} AND accepted_at IS NULL AND revoked_at IS NULL ${IMAGES}), ${historyOf(s, 'sys_invitation', 'u', now, by(auth))} SELECT n->>'email' AS email, n->>'phone' AS phone FROM u`, undefined,
		(row) => row === undefined ? refuse('notFound', 'No open invitation.') : ok(addressesOf({ email: row['email'] as string | null, phone: row['phone'] as string | null }) ?? []));
	if (!r.ok) return r;
	await deliver(h, r.value, id);
	return ok(null);
}

/**
 * Opens or closes self sign-up (the workspace's `signup`): a runtime switch an administrator flips without a release.
 * Closed, only members and invited addresses sign in.
 */
export async function setSignup(h: IdentityHost, auth: Authority, open: boolean): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	if (h.signup === undefined) return refuse('notFound', 'This workspace declares no sign-up.');
	await h.db.write(open ? { text: `DELETE FROM sys_config WHERE key = '${SIGNUP_KEY}'`, params: [] }
		: { text: `INSERT INTO sys_config (key, value) VALUES ('${SIGNUP_KEY}', 'closed') ON CONFLICT (key) DO UPDATE SET value = 'closed'`, params: [] });
	return ok(null);
}

// ── members (rule 38c) ──
/**
 * Clears or sets `admin`, or `active`. Any change that would leave no active admin is refused `lastAdmin` by the count
 * in the statement itself, under the admins lock, so two concurrent demotions cannot both land. Deactivation also
 * deletes the member's push subscriptions.
 */
async function setFlag(h: IdentityHost, auth: Authority, user: string, flag: 'admin' | 'active', value: boolean): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt(), u = s.p(user);
	const keep = value ? 'true' : `EXISTS (SELECT 1 FROM sys_user WHERE admin AND active AND id <> ${u})`;
	const push = flag === 'active' && !value ? `, push AS (DELETE FROM bolt_push_subscriptions WHERE "user" = ${u} AND EXISTS (SELECT 1 FROM changed))` : '';
	const project = flag === 'active' ? projection(h, s, 'changed') : '';
	return write(h, s, `WITH changed AS (UPDATE sys_user SET ${flag} = ${s.p(value)}, revision = revision + 1 WHERE id = ${u} AND (NOT (admin AND active) OR ${keep}) ${IMAGES}),
${historyOf(s, 'sys_user', 'changed', h.now(), by(auth))}${push}${project}
SELECT (SELECT count(*) FROM changed)::int AS n, EXISTS (SELECT 1 FROM sys_user WHERE id = ${u}) AS found`, ADMINS,
		(r) => r?.n === 1 ? ok(null) : r?.found ? refuse('lastAdmin', 'The workspace must keep an active administrator.') : refuse('notFound', 'No such member.'));
}
export const setAdmin = (h: IdentityHost, auth: Authority, user: string, admin: boolean) => setFlag(h, auth, user, 'admin', admin);
export const deactivate = (h: IdentityHost, auth: Authority, user: string) => setFlag(h, auth, user, 'active', false);
export const reactivate = (h: IdentityHost, auth: Authority, user: string) => setFlag(h, auth, user, 'active', true);

export async function assignTeam(h: IdentityHost, auth: Authority, user: string, team: string | null): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt();
	return write(h, s, `WITH u AS (UPDATE sys_user SET team = ${s.p(team)}, revision = revision + 1 WHERE id = ${s.p(user)} ${IMAGES}),
${historyOf(s, 'sys_user', 'u', h.now(), by(auth))}${projection(h, s, 'u')} SELECT id FROM u`, undefined,
		(r) => r === undefined ? refuse('notFound', 'No such member.') : ok(null));
}

export async function createTeam(h: IdentityHost, auth: Authority, name: string, parent: string | null = null): Promise<Result<{ id: string }>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt(), id = newId();
	return write(h, s, `WITH u AS (INSERT INTO sys_team (id, name, parent) VALUES (${s.p(id)}, ${s.p(name)}, ${s.p(parent)}) ${IMAGES}),
${historyOf(s, 'sys_team', 'u', h.now(), by(auth))} SELECT id FROM u`, undefined, () => ok({ id }));
}
/** Moves a team under another parent: every member's `teamTree` changes, so their Authority keys do (rule 37). */
export async function moveTeam(h: IdentityHost, auth: Authority, team: string, parent: string | null): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt();
	return write(h, s, `WITH u AS (UPDATE sys_team SET parent = ${s.p(parent)}, revision = revision + 1 WHERE id = ${s.p(team)} ${IMAGES}),
${historyOf(s, 'sys_team', 'u', h.now(), by(auth))} SELECT id FROM u`, undefined,
		(r) => r === undefined ? refuse('notFound', 'No such team.') : ok(null));
}

/** Renames a team; `+team.ts` policies match the name, so its members' Authority keys move with it (rule 37). */
export async function renameTeam(h: IdentityHost, auth: Authority, team: string, name: string): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt();
	try {
		return await write(h, s, `WITH u AS (UPDATE sys_team SET name = ${s.p(name)}, revision = revision + 1 WHERE id = ${s.p(team)} ${IMAGES}),
${historyOf(s, 'sys_team', 'u', h.now(), by(auth))} SELECT id FROM u`, undefined,
			(r) => r === undefined ? refuse('notFound', 'No such team.') : ok(null));
	} catch (e) {
		if (e instanceof DbError && e.sqlstate === '23505') return refuse('check', 'Another team has this name.');
		throw e;
	}
}
/**
 * Deletes a team in one statement: its sub-teams move up to its parent, its members and open invitations lose it
 * (members are projected, §5.11.3), and its assignments go. Every change keeps its history.
 */
export async function deleteTeam(h: IdentityHost, auth: Authority, team: string): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt(), id = s.p(team), now = h.now(), actor = by(auth);
	return write(h, s, `WITH t AS (SELECT id, parent FROM sys_team WHERE id = ${id}),
kids AS (UPDATE sys_team SET parent = (SELECT parent FROM t), revision = revision + 1 WHERE parent = ${id} AND id <> ${id} ${IMAGES}),
${historyOf(s, 'sys_team', 'kids', now, actor)},
members AS (UPDATE sys_user SET team = NULL, revision = revision + 1 WHERE team = ${id} ${IMAGES}),
${historyOf(s, 'sys_user', 'members', now, actor)},
invites AS (UPDATE sys_invitation SET team = NULL, revision = revision + 1 WHERE team = ${id} ${IMAGES}),
${historyOf(s, 'sys_invitation', 'invites', now, actor)},
grants AS (DELETE FROM sys_assignment WHERE principal_type = 'sys_team' AND principal = ${id} ${IMAGES}),
${historyOf(s, 'sys_assignment', 'grants', now, actor)},
gone AS (DELETE FROM sys_team WHERE id = ${id} ${IMAGES}),
${historyOf(s, 'sys_team', 'gone', now, actor)}${projection(h, s, 'members')} SELECT id FROM gone`, undefined,
		(r) => r === undefined ? refuse('notFound', 'No such team.') : ok(null));
}

export type Principal = { type: 'sys_user' | 'sys_team' | 'sys_api_key'; id: string };
/** An assignment naming an unknown policy is refused and confers nothing (rule 35). */
export async function assign(h: IdentityHost, m: EngineManifest, auth: Authority, principal: Principal, policy: string,
	scope?: { collection: string; id: string }): Promise<Result<{ id: string }>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	if (unknownPolicy(m, [policy]) !== undefined) return refuse('notFound', `There is no policy '${policy}'.`);
	const s = stmt(), id = newId();
	return write(h, s, `WITH u AS (INSERT INTO sys_assignment (id, principal_type, principal, policy, scope)
VALUES (${s.p(id)}, ${s.p(principal.type)}, ${s.p(principal.id)}, ${s.p(policy)}, ${s.p(jsonb(scope))}::jsonb) ${IMAGES}),
${historyOf(s, 'sys_assignment', 'u', h.now(), by(auth))} SELECT id FROM u`, undefined, () => ok({ id }));
}
export async function unassign(h: IdentityHost, auth: Authority, id: string): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt();
	return write(h, s, `WITH u AS (DELETE FROM sys_assignment WHERE id = ${s.p(id)} ${IMAGES}), ${historyOf(s, 'sys_assignment', 'u', h.now(), by(auth))} SELECT id FROM u`, undefined,
		(r) => r === undefined ? refuse('notFound', 'No such assignment.') : ok(null));
}

// ── API keys (§5.11.2): `nbk_<prefix>_<secret>`, stored as SHA-256, shown once ──
const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const prefixOf = () => Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('hex');

export async function issueKey(h: IdentityHost, auth: Authority, name: string): Promise<Result<{ id: string; key: string }>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const id = newId(), prefix = prefixOf(), key = `nbk_${prefix}_${secret()}`, s = stmt();
	return write(h, s, `INSERT INTO sys_api_key (id, name, prefix, hash, created_by)
VALUES (${s.p(id)}, ${s.p(name)}, ${s.p(prefix)}, ${s.p(sha256(key))}, ${s.p(auth.actor.kind === 'member' ? auth.actor.id : null)})`, undefined, () => ok({ id, key }));
}
/** A new secret under the same principal; the revision moves, so a cached Authority for the old one is never hit. */
export async function rotateKey(h: IdentityHost, auth: Authority, id: string): Promise<Result<{ key: string }>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const prefix = prefixOf(), key = `nbk_${prefix}_${secret()}`, s = stmt();
	return write(h, s, `UPDATE sys_api_key SET prefix = ${s.p(prefix)}, hash = ${s.p(sha256(key))}, revision = revision + 1
WHERE id = ${s.p(id)} AND revoked_at IS NULL RETURNING id`, undefined, (r) => r === undefined ? refuse('notFound', 'No such key.') : ok({ key }));
}
export async function revokeKey(h: IdentityHost, auth: Authority, id: string): Promise<Result<null>> {
	const denied = requireAdmin(auth);
	if (denied) return denied;
	const s = stmt();
	return write(h, s, `UPDATE sys_api_key SET revoked_at = ${s.p(h.now().toISOString())}::timestamptz, revision = revision + 1
WHERE id = ${s.p(id)} AND revoked_at IS NULL RETURNING id`, undefined, (r) => r === undefined ? refuse('notFound', 'No such key.') : ok(null));
}
/** `Authorization: Bearer nbk_<prefix>_<secret>` → the key's id, or `null` (unknown, revoked or wrong secret). */
export async function authenticateKey(h: IdentityHost, bearer: string): Promise<string | null> {
	const m = /^nbk_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/.exec(bearer);
	if (m === null) return null;
	const [rows] = await h.db.read([{ text: 'SELECT id, hash FROM sys_api_key WHERE prefix = $1 AND revoked_at IS NULL', params: [m[1]!] }]);
	const r = rows!.rows[0] as { id: string; hash: string } | undefined;
	return r !== undefined && timingSafeEqual(Buffer.from(sha256(bearer), 'hex'), Buffer.from(r.hash, 'hex')) ? r.id : null;
}

/**
 * The `bolt.membership` platform run (§5.11.3): hands the queued `{ user, email, phone, team, state }` to the host's port. A
 * port failure fails the run with the facility's kind.
 * ponytail: platform runs take one attempt, so a failed projection waits for the member's next lifecycle change; give
 * platform runs retries when a host's directory drifts.
 */
export function membershipRun(port: MembershipPort): (input: Json) => Promise<Json> {
	return async (input) => {
		const r = await callPort('membership', port, LIMITS.callMs.other, (p, signal) => p.project(input as unknown as Parameters<MembershipPort['project']>[0], signal));
		if (typeof r === 'object' && r !== null && 'kind' in r) throw new BoltError(r.kind === 'timeout' ? 'timeout' : r.kind === 'unavailable' ? 'unavailable' : 'upstream', 'guest',
			'message' in r ? r.message : r.reason);
		return null;
	};
}
