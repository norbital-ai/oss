// Member administration (rules 38b, 38c): invitations, the admin flag with its `lastAdmin` guard, (de)activation,
// member team selection and API keys. Definitions and policy grants remain source declarations.
import type { Json } from '../../decl/values.ts';
import { audited, auditActor } from '../audit-operation.ts';
import { Audit } from '../audit.ts';
import type { AuditActor } from '../../protocol/audit.ts';
import { fromHex, timingSafeEqual, toBase64url } from '../crypto.ts';
import { toHex } from '@norbital-ai/store';
import { under } from '../../protocol/wire.ts';
import { Effect, Result, Schema } from 'effect';
import {
	LIMITS,
	type Authority,
	type RowData,
	type Lock,
	type MembershipPort
} from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { Port } from '../port.ts';
import { DbError, IdentityRefusal, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { ADDRESS_HINT, digits, parseAddress, type Address } from './address.ts';
import {
	identityPort,
	identityRow,
	InvitationSchema,
	acceptPieces,
	announceMembership,
	by,
	MEMBERSHIP,
	identityHistory,
	IMAGES,
	jsonb,
	newId,
	projection,
	refuse,
	requireAdmin,
	sha256,
	SIGNUP_KEY,
	IdentityStatement,
	type IdentityHost
} from './session.ts';
const INVITE_MS = 7 * 24 * 3600000;
/** Serializes every change to who is an active admin, so the count assert sees the other writer (rule 38c race). */
const ADMINS: Lock = { advisory: ['sys_user.admins'] };
function write(
	h: IdentityHost,
	s: IdentityStatement,
	text: string,
	lock?: Lock
): Effect.Effect<null, EngineError>;
function write<T>(
	h: IdentityHost,
	s: IdentityStatement,
	text: string,
	lock: Lock | undefined,
	read: (row: RowData | undefined) => T | IdentityRefusal
): Effect.Effect<T, EngineError>;
function write<T>(
	h: IdentityHost,
	s: IdentityStatement,
	text: string,
	lock?: Lock,
	read?: (row: RowData | undefined) => T | IdentityRefusal
): Effect.Effect<T | null, EngineError> {
	return Effect.gen(function* (): Effect.fn.Return<T | null, EngineError> {
		const audit = h.audit ?? (yield* Audit);
		const member = s.params.find(
			(value) => typeof value === 'string' && value.startsWith('member:')
		);
		const actor: AuditActor =
			s.auditActor !== undefined
				? auditActor(s.auditActor)
				: typeof member === 'string'
					? { kind: 'member', id: member.slice(7), label: null }
					: { kind: 'system', id: 'host', label: null };
		const safe = s.params.map((value) =>
			typeof value === 'string' && (/^[0-9a-f]{64}$/i.test(value) || value.startsWith('nbk_'))
				? '[credential redacted]'
				: value
		);
		const out = yield* audited(
			h.db,
			{
				category: 'identity',
				action:
					(/\b(?:INTO|UPDATE|FROM)\s+(sys_[a-z_]+)/i.exec(text)?.[1] ?? 'identity') + '.mutate',
				actor,
				payload: { parameters: safe }
			},
			h.db.write({ text, params: s.params }, lock)
		).pipe(Effect.provideService(Audit, audit));
		if (h.events !== undefined) yield* h.events.announce;
		if (s.params.includes(MEMBERSHIP)) yield* announceMembership(h);
		const value = read === undefined ? null : read(out.rows[0]);
		return value instanceof IdentityRefusal ? yield* Effect.fail(value) : value;
	}).pipe(
		Effect.catchTag('DbError', (error): Effect.Effect<never, DbError | IdentityRefusal> =>
			error.sqlstate === '23514'
				? Effect.fail(
						refuse('check', 'A member rule refused the change (only staff can be administrators).')
					)
				: Effect.fail(error)
		)
	);
}
const unknownTeam = (m: EngineManifest, team: string | null | undefined) =>
	team != null && !Object.hasOwn(m.teams, team);
// ── invitations (rule 38b) ──
/** An invitation names its person by email, by mobile number (international form), or both; the link goes to each. */
type InviteInput = {
	email?: string;
	phone?: string;
	team?: string;
	external?: boolean;
	party?: {
		model: string;
		id: string;
	};
};
const deliver = Effect.fn('Bolt.deliver')(function* (
	h: IdentityHost,
	to: readonly Address[],
	id: string
) {
	const link = under(h.publicUrl, `/invite/${id}`);
	for (const a of to) {
		const sent =
			a.kind === 'email'
				? yield* identityPort('email', h.mail, LIMITS.callMs.other, (mail, signal) =>
						mail.send(
							'email',
							{
								to: a.value,
								subject: 'You are invited to a workspace',
								text: `Accept your invitation: ${link}`,
								link
							},
							signal
						)
					)
				: yield* identityPort('sms', h.sms, LIMITS.callMs.other, (sms, signal) =>
						sms.send(
							'sms',
							{
								to: a.value,
								text: `You are invited to a workspace. Accept your invitation: ${link}`
							},
							signal
						)
					);
		if (Result.isFailure(sent))
			return yield* Effect.fail(
				refuse('upstream', 'The invitation could not be delivered. Resend it from Invitations.')
			);
	}
});
/** The addresses an invitation names, parsed; `null` when one is malformed or there is none. */
function addressesOf(input: { email?: string | null; phone?: string | null }): Address[] | null {
	const typed = [input.email, input.phone].filter(
		(x): x is string => typeof x === 'string' && x.trim() !== ''
	);
	const parsed = typed.map(parseAddress);
	return parsed.length === 0 ||
		parsed.some((a) => a === null) ||
		parsed.filter((a) => a!.kind === 'email').length > 1 ||
		parsed.filter((a) => a!.kind === 'phone').length > 1
		? null
		: (parsed as Address[]);
}
/** Admin-only; never sets `admin`. The notice's link is built from the host's public origin (§5.11.6). */
export const invite = Effect.fn('Bolt.invite')(function* (
	h: IdentityHost,
	m: EngineManifest,
	auth: Authority,
	input: InviteInput
) {
	const result = yield* inviteMany(h, m, auth, [input]);
	if (result.failed.length !== 0)
		return yield* Effect.fail(
			refuse(
				'upstream',
				'The invitation was saved, but delivery failed. Resend it from Invitations.'
			)
		);
	return { id: result.ids[0]! };
});
/** Validate the entire batch before saving; all invitations commit together. */
export const inviteMany = Effect.fn('Bolt.inviteMany')(function* (
	h: IdentityHost,
	m: EngineManifest,
	auth: Authority,
	inputs: readonly InviteInput[]
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	if (inputs.length === 0 || inputs.length > 1000)
		return yield* Effect.fail(refuse('check', 'Invite between 1 and 1000 people at once.'));
	const prepared: { input: InviteInput; to: Address[]; id: string }[] = [];
	const seen = new Set<string>();
	for (const input of inputs) {
		const to = addressesOf(input);
		if (to === null) return yield* Effect.fail(refuse('check', ADDRESS_HINT));
		for (const address of to) {
			const key = `${address.kind}:${address.value.toLowerCase()}`;
			if (seen.has(key))
				return yield* Effect.fail(
					refuse('check', 'An address appears more than once in the invitation batch.')
				);
			seen.add(key);
		}
		if (unknownTeam(m, input.team))
			return yield* Effect.fail(refuse('notFound', `There is no source team '${input.team}'.`));
		prepared.push({ input, to, id: yield* newId(h.crypto) });
	}
	const now = yield* h.now,
		s = new IdentityStatement({ ...h, events: h.events ?? { announce: Effect.void } });
	const values = prepared.map(
		({
			input,
			to,
			id
		}) => `(${s.p(id)}, ${s.p(to.find((a) => a.kind === 'email')?.value ?? null)}, ${s.p(to.find((a) => a.kind === 'phone')?.value ?? null)},
		${s.p(input.team ?? null)}, ${s.p(input.external === true)}, ${s.p(jsonb(input.party))}::jsonb,
		${s.p(auth.actor.kind === 'member' ? auth.actor.id : null)}, ${s.p(new Date(now.getTime() + INVITE_MS).toISOString())}::timestamptz)`
	);
	yield* write(
		h,
		s,
		`WITH ins AS (INSERT INTO sys_invitation (id, email, phone, team, external, party, invited_by, expires_at)
	VALUES ${values.join(',')} ${IMAGES}), ${identityHistory(s, 'sys_invitation', 'ins', now, by(auth))} SELECT 1`
	);
	const failed: string[] = [];
	for (let offset = 0; offset < prepared.length; offset += 20) {
		const batch = prepared.slice(offset, offset + 20);
		const deliveries = yield* Effect.all(
			batch.map(({ to, id }) => deliver(h, to, id)),
			{ concurrency: 'unbounded', mode: 'result' }
		);
		deliveries.forEach((delivery, index) => {
			if (Result.isFailure(delivery)) failed.push(batch[index]!.id);
		});
	}
	return { ids: prepared.map(({ id }) => id), failed };
});
/** Inspecting the link never consumes or changes it. */
export const inspectInvitation = Effect.fn('Bolt.inspectInvitation')(function* (
	h: IdentityHost,
	id: string
) {
	const [rows] = yield* h.db.read([
		{
			text: 'SELECT email, phone, team, external, expires_at, accepted_at, revoked_at FROM sys_invitation WHERE id = $1',
			params: [id]
		}
	]);
	const r = yield* identityRow(
		Schema.UndefinedOr(
			Schema.Struct({
				email: Schema.NullOr(Schema.String),
				phone: Schema.NullOr(Schema.String),
				team: Schema.NullOr(Schema.String),
				external: Schema.Boolean,
				expires_at: Schema.String,
				accepted_at: Schema.NullOr(Schema.String),
				revoked_at: Schema.NullOr(Schema.String)
			})
		),
		rows!.rows[0]
	);
	if (r === undefined) return null;
	const status =
		r.accepted_at !== null
			? 'accepted'
			: r.revoked_at !== null
				? 'revoked'
				: Date.parse(r.expires_at) <= (yield* h.now).getTime()
					? 'expired'
					: 'open';
	return { email: r.email, phone: r.phone, team: r.team, external: r.external, status };
});
/**
 * Only a session for an invited address (the member's email or their number) accepts; the member's source team, kind and party land in one act. An
 * expired, revoked or used invitation refuses `expired` and is left as it was.
 */
export const acceptInvitation = Effect.fn('Bolt.acceptInvitation')(function* (
	h: IdentityHost,
	session: {
		user: string;
	},
	id: string
) {
	const now = yield* h.now;
	const [invs, users] = yield* h.db.read([
		{
			text: 'SELECT id, email, phone, team, external, party, expires_at, accepted_at, revoked_at FROM sys_invitation WHERE id = $1',
			params: [id]
		},
		{ text: 'SELECT email, phone FROM sys_user WHERE id = $1 AND active', params: [session.user] }
	]);
	const inv = yield* identityRow(
		Schema.UndefinedOr(
			Schema.Struct({
				...InvitationSchema.fields,
				expires_at: Schema.String,
				accepted_at: Schema.NullOr(Schema.String),
				revoked_at: Schema.NullOr(Schema.String)
			})
		),
		invs!.rows[0]
	);
	const member = yield* identityRow(
		Schema.UndefinedOr(
			Schema.Struct({ email: Schema.NullOr(Schema.String), phone: Schema.NullOr(Schema.String) })
		),
		users!.rows[0]
	);
	if (inv === undefined) return yield* Effect.fail(refuse('notFound', 'No such invitation.'));
	const sameEmail =
		member?.email != null &&
		inv.email !== null &&
		member.email.toLowerCase() === inv.email.toLowerCase();
	const samePhone =
		member?.phone != null && inv.phone !== null && digits(member.phone) === digits(inv.phone);
	if (!sameEmail && !samePhone)
		return yield* Effect.fail(refuse('forbidden', 'This invitation is for another address.'));
	if (
		inv.accepted_at !== null ||
		inv.revoked_at !== null ||
		Date.parse(inv.expires_at) <= now.getTime()
	)
		return yield* Effect.fail(refuse('expired', 'This invitation has expired.'));
	const s = new IdentityStatement(h);
	return yield* write(
		h,
		s,
		`WITH ${acceptPieces(s, inv, session.user, now, 'true', false)}${projection(h, s, 'member', now)} SELECT (SELECT count(*) FROM member)::int AS n`,
		undefined,
		(r) => (r?.n === 1 ? null : refuse('expired', 'This invitation has expired.'))
	);
});
export const revokeInvitation = Effect.fn('Bolt.revokeInvitation')(function* (
	h: IdentityHost,
	auth: Authority,
	id: string
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	const s = new IdentityStatement(h);
	return yield* write(
		h,
		s,
		`WITH u AS (UPDATE sys_invitation SET revoked_at = ${s.p((yield* h.now).toISOString())}::timestamptz, revision = revision + 1
WHERE id = ${s.p(id)} AND accepted_at IS NULL AND revoked_at IS NULL ${IMAGES}), ${identityHistory(s, 'sys_invitation', 'u', yield* h.now, by(auth))} SELECT id FROM u`,
		undefined,
		(r) => (r === undefined ? refuse('notFound', 'No open invitation.') : null)
	);
});
/**
 * `sys_invitation.resend` (rule 38c): an invitation not yet accepted or revoked (expired included) gets a fresh 7-day
 * expiry and its notice again.
 */
export const resendInvitation = Effect.fn('Bolt.resendInvitation')(function* (
	h: IdentityHost,
	auth: Authority,
	id: string
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	const s = new IdentityStatement(h),
		now = yield* h.now;
	const r = yield* write(
		h,
		s,
		`WITH u AS (UPDATE sys_invitation SET expires_at = ${s.p(new Date(now.getTime() + INVITE_MS).toISOString())}::timestamptz, revision = revision + 1
WHERE id = ${s.p(id)} AND accepted_at IS NULL AND revoked_at IS NULL ${IMAGES}), ${identityHistory(s, 'sys_invitation', 'u', now, by(auth))} SELECT n->>'email' AS email, n->>'phone' AS phone FROM u`,
		undefined,
		(row) =>
			row === undefined
				? refuse('notFound', 'No open invitation.')
				: (addressesOf({
						email: row['email'] as string | null,
						phone: row['phone'] as string | null
					}) ?? [])
	);
	yield* deliver(h, r, id);
	return null;
});
/**
 * Opens or closes self sign-up (the workspace's `signup`): a runtime switch an administrator flips without a release.
 * Closed, only members and invited addresses sign in.
 */
export const setSignup = Effect.fn('Bolt.setSignup')(function* (
	h: IdentityHost,
	auth: Authority,
	open: boolean
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	if (h.signup === undefined)
		return yield* Effect.fail(refuse('notFound', 'This workspace declares no sign-up.'));
	yield* h.db.write(
		open
			? { text: `DELETE FROM sys_config WHERE key = '${SIGNUP_KEY}'`, params: [] }
			: {
					text: `INSERT INTO sys_config (key, value) VALUES ('${SIGNUP_KEY}', 'closed') ON CONFLICT (key) DO UPDATE SET value = 'closed'`,
					params: []
				}
	);
	return null;
});
const setFlag = Effect.fn('Bolt.setFlag')(function* (
	h: IdentityHost,
	auth: Authority,
	user: string,
	flag: 'admin' | 'active',
	value: boolean
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	const s = new IdentityStatement(h),
		u = s.p(user);
	const keep = value
		? 'true'
		: `EXISTS (SELECT 1 FROM sys_user WHERE admin AND active AND id <> ${u})`;
	const push =
		flag === 'active' && !value
			? `, push AS (DELETE FROM bolt_push_subscriptions WHERE "user" = ${u} AND EXISTS (SELECT 1 FROM changed))`
			: '';
	const project = flag === 'active' ? projection(h, s, 'changed', yield* h.now) : '';
	return yield* write(
		h,
		s,
		`WITH changed AS (UPDATE sys_user SET ${flag} = ${s.p(value)}, revision = revision + 1 WHERE id = ${u} AND (NOT (admin AND active) OR ${keep}) ${IMAGES}),
${identityHistory(s, 'sys_user', 'changed', yield* h.now, by(auth))}${push}${project}
SELECT (SELECT count(*) FROM changed)::int AS n, EXISTS (SELECT 1 FROM sys_user WHERE id = ${u}) AS found`,
		ADMINS,
		(r) =>
			r?.n === 1
				? null
				: r?.found
					? refuse('lastAdmin', 'The workspace must keep an active administrator.')
					: refuse('notFound', 'No such member.')
	);
});
export const setAdmin = (h: IdentityHost, auth: Authority, user: string, admin: boolean) =>
	setFlag(h, auth, user, 'admin', admin);
export const deactivate = (h: IdentityHost, auth: Authority, user: string) =>
	setFlag(h, auth, user, 'active', false);
export const reactivate = (h: IdentityHost, auth: Authority, user: string) =>
	setFlag(h, auth, user, 'active', true);
export const assignTeam = Effect.fn('Bolt.assignTeam')(function* (
	h: IdentityHost,
	m: EngineManifest,
	auth: Authority,
	user: string,
	team: string | null
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	if (unknownTeam(m, team))
		return yield* Effect.fail(refuse('notFound', `There is no source team '${team}'.`));
	const s = new IdentityStatement(h);
	return yield* write(
		h,
		s,
		`WITH u AS (UPDATE sys_user SET team = ${s.p(team)}, revision = revision + 1 WHERE id = ${s.p(user)} ${IMAGES}),
${identityHistory(s, 'sys_user', 'u', yield* h.now, by(auth))}${projection(h, s, 'u', yield* h.now)} SELECT id FROM u`,
		undefined,
		(r) => (r === undefined ? refuse('notFound', 'No such member.') : null)
	);
});
/**
 * Sets a member's conversation handles (rule 57): the mobile number a private envoy knows them by on WhatsApp (international
 * form, stored as `+` and its digits) and their Telegram handle. A key left out keeps its value; `null` or `''` clears it.
 * A number another member holds is refused.
 */
export const setHandles = Effect.fn('Bolt.setHandles')(function* (
	h: IdentityHost,
	auth: Authority,
	user: string,
	input: {
		phone?: string | null;
		telegram?: string | null;
	}
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	const typed = input.phone?.trim() ?? '';
	const phone = typed === '' ? null : parseAddress(typed);
	if (typed !== '' && phone?.kind !== 'phone')
		return yield* Effect.fail(
			refuse('check', 'Enter a mobile number with its country code (+65 8123 4567).')
		);
	const telegram = input.telegram?.trim().replace(/^@/, '') || null;
	const s = new IdentityStatement(h);
	const set = [
		...(input.phone === undefined ? [] : [`phone = ${s.p(phone?.value ?? null)}`]),
		...(input.telegram === undefined ? [] : [`telegram = ${s.p(telegram)}`])
	];
	if (set.length === 0) return yield* Effect.fail(refuse('check', 'Nothing to change.'));
	return yield* Effect.gen(function* () {
		return yield* write(
			h,
			s,
			`WITH u AS (UPDATE sys_user SET ${set.join(', ')}, revision = revision + 1 WHERE id = ${s.p(user)} ${IMAGES}),
${identityHistory(s, 'sys_user', 'u', yield* h.now, by(auth))}${projection(h, s, 'u', yield* h.now)} SELECT id FROM u`,
			undefined,
			(r) => (r === undefined ? refuse('notFound', 'No such member.') : null)
		);
	}).pipe(
		Effect.catch((e) =>
			Effect.gen(function* () {
				if (e instanceof DbError && e.sqlstate === '23505')
					return yield* Effect.fail(refuse('check', 'Another member has this mobile number.'));
				return yield* Effect.fail(e);
			})
		)
	);
});
// ── API keys (§5.11.2): `nbk_<prefix>_<secret>`, stored as SHA-256, shown once ──
const secret = () => toBase64url(crypto.getRandomValues(new Uint8Array(32)));
const prefixOf = () => toHex(crypto.getRandomValues(new Uint8Array(6)));
export const issueKey = Effect.fn('Bolt.issueKey')(function* (
	h: IdentityHost,
	m: EngineManifest,
	auth: Authority,
	name: string,
	team: string | null = null
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	if (unknownTeam(m, team))
		return yield* Effect.fail(refuse('notFound', `There is no source team '${team}'.`));
	const id = yield* newId(h.crypto),
		prefix = prefixOf(),
		key = `nbk_${prefix}_${secret()}`,
		s = new IdentityStatement(h, auth.actor);
	return yield* write(
		h,
		s,
		`INSERT INTO sys_api_key (id, name, prefix, hash, team, created_by)
VALUES (${s.p(id)}, ${s.p(name)}, ${s.p(prefix)}, ${s.p(sha256(key))}, ${s.p(team)}, ${s.p(auth.actor.kind === 'member' ? auth.actor.id : null)})`,
		undefined,
		() => ({ id, key })
	);
});
/** A new secret under the same principal; the revision moves, so a cached Authority for the old one is never hit. */
export const rotateKey = Effect.fn('Bolt.rotateKey')(function* (
	h: IdentityHost,
	auth: Authority,
	id: string
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	const prefix = prefixOf(),
		key = `nbk_${prefix}_${secret()}`,
		s = new IdentityStatement(h, auth.actor);
	return yield* write(
		h,
		s,
		`UPDATE sys_api_key SET prefix = ${s.p(prefix)}, hash = ${s.p(sha256(key))}, revision = revision + 1
WHERE id = ${s.p(id)} AND revoked_at IS NULL RETURNING id`,
		undefined,
		(r) => (r === undefined ? refuse('notFound', 'No such key.') : { key })
	);
});
export const revokeKey = Effect.fn('Bolt.revokeKey')(function* (
	h: IdentityHost,
	auth: Authority,
	id: string
) {
	const denied = requireAdmin(auth);
	if (denied) return yield* Effect.fail(denied);
	const s = new IdentityStatement(h, auth.actor);
	return yield* write(
		h,
		s,
		`UPDATE sys_api_key SET revoked_at = ${s.p((yield* h.now).toISOString())}::timestamptz, revision = revision + 1
WHERE id = ${s.p(id)} AND revoked_at IS NULL RETURNING id`,
		undefined,
		(r) => (r === undefined ? refuse('notFound', 'No such key.') : null)
	);
});
/** `Authorization: Bearer nbk_<prefix>_<secret>` → the key's id, or `null` (unknown, revoked or wrong secret). */
export const authenticateKey = Effect.fn('Bolt.authenticateKey')(function* (
	h: IdentityHost,
	bearer: string
) {
	const m = /^nbk_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/.exec(bearer);
	if (m === null) return null;
	const [rows] = yield* h.db.read([
		{
			text: 'SELECT id, hash FROM sys_api_key WHERE prefix = $1 AND revoked_at IS NULL',
			params: [m[1]!]
		}
	]);
	const r = yield* identityRow(
		Schema.UndefinedOr(Schema.Struct({ id: Schema.String, hash: Schema.String })),
		rows!.rows[0]
	);
	return r !== undefined && timingSafeEqual(fromHex(sha256(bearer)), fromHex(r.hash)) ? r.id : null;
});
/**
 * The `bolt.membership` platform run (§5.11.3): hands the queued `{ user, email, phone, team, state }` to the host's port. A
 * port failure fails the run with the facility's kind.
 * ponytail: platform runs take one attempt, so a failed projection waits for the member's next lifecycle change; give
 * platform runs retries when a host's directory drifts.
 */
const MembershipInput = Schema.Struct({
	user: Schema.String,
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	team: Schema.NullOr(Schema.String),
	state: Schema.Literals(['active', 'inactive'])
});
export function membershipRun(port: MembershipPort) {
	return Effect.fn('Bolt.membership')(function* (input: Json) {
		const value = yield* Schema.decodeUnknownEffect(MembershipInput)(input).pipe(
			Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
		);
		yield* Port.attempt('membership', (signal) => port.project(value, signal)).pipe(
			Port.call('membership', LIMITS.callMs.other),
			Effect.mapError((error) =>
				BoltError.make(
					error._tag === 'Unavailable' ? 'unavailable' : error.kind,
					'guest',
					error._tag === 'Unavailable' ? error.reason : error.message,
					error
				)
			)
		);
		return null;
	});
}
