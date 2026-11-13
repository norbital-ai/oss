// Sessions and sign-in: a one-time code, emailed or texted, against a persisted challenge, sessions stored
// only as a SHA-256 of their token, the host operations `session.mint` and `founder.bootstrap`. Every act is
// one write statement that also persists its rate increments; reads and pre-statement refusals are memory-only.
import type { Json } from '../../decl/values.ts';
import { Audit } from '../audit.ts';
import { audited, type AuditIntent } from '../audit-operation.ts';
import { fromHex, hmacSha256, timingSafeEqual, toBase64url } from '../crypto.ts';
import { canonical, sha256 as sha256Bytes, to_hex } from '@norbital-ai/store';
import { addressBucket, macKey, ratePiece, type Charge, type RateWindows } from '../access/rate.ts';
import { RATE_LIMITED } from '../../protocol/wire.ts';
import { LIMITS, type Authority, type Lock, type TransportPort } from '../contracts.ts';
import { Clock, Crypto, Effect, Layer, Option, Result, Schema } from 'effect';
import { relations, type EngineManifest } from '../manifest.ts';
import { TenantDb as TenantDbService, type TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { CapturedResult, capturePiece, nativeCommit, type CommitPublication } from '../db/captured.ts';
import { storedRowSql } from '../db/stored.ts';
import { Activation, HostIdentity, Identity, Live, Manifest, type Authenticated } from '../services.ts';
import { catalog_of, toOwnSql } from '../access/pred.ts';
import { Authorities } from './actor.ts';
import { RateWindows as Windows } from '../access/rate.ts';
import { Port, type PortFailure } from '../port.ts';
import { DbError, IdentityRefusal } from '../errors.ts';
import { answer, Chain, GATED, gate } from '../write/sql.ts';
import { history_piece } from '../write/commit.ts';
import { enqueue, queue_events, triggers_of, type WriteTrigger } from '../runs/queue.ts';
import {
	ADDRESS_HINT,
	addressKey,
	member_column,
	member_value,
	parse_address,
	type Address
} from './address.ts';
/**
 * Self sign-up (the workspace's `signup`): who may join without an invitation, by which proof, holding which policies, and
 * the record that is them — the row of `party.model` whose `party.match[kind]` field holds the proven address.
 */
export type Signup = {
	via: readonly ('email' | 'phone')[];
	policies: readonly string[];
	party?: {
		model: string;
		match: {
			readonly email?: string;
			readonly phone?: string;
		};
	};
};
/** The workspace's declared self sign-up, as identity hosts take it. */
export const signup_of = (m: Pick<EngineManifest, 'workspace'>): Signup | undefined =>
	m.workspace.signup;
/** The `sys_config` key an administrator closes self sign-up with (`'closed'`); absent, a declared sign-up is open. */
export const SIGNUP_KEY = 'signup';
/**
 * Sends and checks its own six-digit codes to a mobile number, by each of `via`. `check` is `false` for a wrong,
 * expired or used code; a throw is a failure to ask.
 */
export type PhoneVerifier = {
	via: readonly ('sms' | 'whatsapp')[];
	start(to: string, via: 'sms' | 'whatsapp', signal: AbortSignal): Promise<void>;
	check(to: string, code: string, signal: AbortSignal): Promise<boolean>;
};
/**
 * A local host's phone verifier: its own code, printed by `log` as `(sign-in code 123456)` (bolt dev, a local host,
 * tests). `fixed` is 38a(f)'s `123456`.
 */
export function logged_phone(log: (line: string) => void, fixed = false): PhoneVerifier {
	const codes = new Map<string, { code: string; until: number }>();
	return {
		via: ['sms', 'whatsapp'],
		async start(to, via) {
			const code = fixed ? '123456' : sixDigits();
			codes.set(to, { code, until: Date.now() + CODE_MS });
			log(`${via} → ${to}: Your sign-in code is ${code}. (sign-in code ${code})`);
		},
		async check(to, code) {
			const held = codes.get(to);
			if (held === undefined || held.until <= Date.now() || held.code !== code) return false;
			codes.delete(to);
			return true;
		}
	};
}
/**
 * What identity needs from its host (the host's transactional messaging): `mail` sends emailed codes and
 * invitations, `sms` texted invitations, `phone` sends and checks a mobile number's code — without it, numbers
 * cannot sign in. `dev_sink` is a local host's (its facilities' `fixed_codes`) and the test kit's: the fixed code `123456` (38a(f)).
 */
export type IdentityHost = {
	readonly audit?: import('../audit.ts').AuditShape;
	crypto: Crypto.Crypto;
	/** Bootstrap has no subscriptions; activation binds the actual live lane before admitting requests. */
	publication: CommitPublication;
	db: TenantDb;
	now: Effect.Effect<Date>;
	windows: RateWindows;
	/** Read when a sign-in needs them (`lazyKeys`), never at a cold start: most starts of a cell sign nobody in. */
	keys: Keys | Effect.Effect<Keys, DbError>;
	mail?: TransportPort | undefined;
	sms?: TransportPort | undefined;
	phone?: PhoneVerifier | undefined;
	dev_sink?: boolean | undefined;
	public_url: string;
	/** The workspace's `signup` declaration; absent, only invited members join. */
	signup?: Signup | undefined;
	/**
	 * present when the host binds the `membership` port. Member lifecycle verbs then queue `bolt.membership` in
	 * their statement, and `announce` wakes the run queue for it.
	 */
	membership?: {
		announce(at: string): Effect.Effect<void>;
	};
	/** The automations listening to `sys_user` and `sys_invitation` writes (`triggers_of(m).writes`); absent, none. */
	writes?: readonly WriteTrigger[] | undefined;
};
export type Keys = {
	session: Uint8Array;
	ipMac: Uint8Array;
};
export const refuse = (
	code: IdentityRefusal['code'],
	message: string,
	retryAfter?: number
): IdentityRefusal =>
	new IdentityRefusal({ code, message, ...(retryAfter === undefined ? {} : { retryAfter }) });
/** Native identity statements bind through the same Chain as domain statements. */
export class IdentityStatement extends Chain {
	readonly auditActor: import('../contracts.ts').EngineActor | undefined;
	constructor(actor?: import('../contracts.ts').EngineActor) {
		super();
		this.auditActor = actor;
	}
}
export const sha256 = (s: string) => to_hex(sha256Bytes(s));
const randomToken = () => toBase64url(crypto.getRandomValues(new Uint8Array(32)));
export const newId = (crypto: Crypto.Crypto) =>
	crypto
		.randomUUIDv4()
		.pipe(Effect.mapError(() => refuse('unavailable', 'Secure random UUID generation failed.')));
const HOUR = 3600000,
	DAY = 24 * HOUR;
const SESSION_MS = 7 * DAY;
/** An anonymous user's session (its `via`) and how long it lives unused: the visitor cookie's lifetime, the prune's horizon. */
const ANONYMOUS = 'anonymous',
	ANONYMOUS_MS = 30 * DAY;
const CODE_MS = 10 * 60000,
	ATTEMPTS = 3;
/** Texts to numbers that are not yet members, per workspace per hour: what open sign-up can cost at most. */
export const SIGNUP_TEXTS = 50;
/** What one address may spend of them, so no single caller can close sign-up for the hour. */
export const SIGNUP_TEXTS_PER_IP = 10;
export const requireAdmin = (auth: Authority): Effect.Effect<void, IdentityRefusal> =>
	auth.admin && auth.actor.kind === 'member'
		? Effect.void
		: Effect.fail(refuse('forbidden', 'Only an administrator can do this.'));
const portRefusal = (error: PortFailure, message: string) =>
	refuse(error._tag === 'Unavailable' ? 'unavailable' : error.kind === 'timeout' ? 'timeout' : 'upstream', message);
/**
 * Rule 38a(e): the session secret and `ip_mac` are 32 host-random bytes, written with `ON CONFLICT DO NOTHING` and
 * re-read, so two cells racing agree. Existing persisted keys need no initialization write.
 */
const StoredKey = Schema.Struct({
	key: Schema.Literals(['session', 'ip_mac']),
	value: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/))
});
export const load_keys = Effect.fn('Bolt.load_keys')(function* (db: TenantDb) {
	const read = () =>
		db
			.rows(StoredKey, {
				text: `SELECT key, value FROM sys_config WHERE key IN ('session', 'ip_mac')`,
				params: []
			})
			.pipe(
				Effect.mapError((error) =>
					error instanceof DbError
						? error
						: DbError.make('XX000', 'Stored session keys are invalid.')
				)
			);
	let rows = yield* read();
	if (!rows.some((row) => row.key === 'session') || !rows.some((row) => row.key === 'ip_mac')) {
		const hex = () => to_hex(crypto.getRandomValues(new Uint8Array(32)));
		yield* db.write({
			text: `INSERT INTO sys_config (key, value) VALUES ('session', $1), ('ip_mac', $2) ON CONFLICT (key) DO NOTHING`,
			params: [hex(), hex()]
		});
		rows = yield* read();
	}
	const session = rows.find((row) => row.key === 'session'),
		ipMac = rows.find((row) => row.key === 'ip_mac');
	if (session === undefined || ipMac === undefined)
		return yield* Effect.fail(
			DbError.make('XX000', 'Session keys are missing after initialization.')
		);
	return { session: fromHex(session.value), ipMac: fromHex(ipMac.value) };
});
// ── pre-sign-in limits: constants, per address MAC and per IP MAC ──
/** The keys, read once on first need; a failed read is tried again by the next. */
export const lazyKeys = (db: TenantDb) => {
	let loaded: Keys | undefined;
	return Effect.suspend(() =>
		loaded === undefined
			? Effect.tap(load_keys(db), (keys) =>
					Effect.sync(() => {
						loaded = keys;
					})
				)
			: Effect.succeed(loaded)
	);
};
export const keysOf = (h: Pick<IdentityHost, 'keys'>) =>
	Effect.isEffect(h.keys) ? h.keys : Effect.succeed(h.keys);
function preSignIn(
	keys: Keys,
	rule: 'session.send_code' | 'session.verify_code',
	a: Address,
	ip: string
): Charge[] {
	return [
		{
			rule,
			bucket: macKey(keys.ipMac, addressKey(a)),
			limit: rule === 'session.send_code' ? 5 : 20,
			windowMs: HOUR
		},
		{
			rule: 'session.ip',
			bucket: macKey(keys.ipMac, addressBucket(ip)),
			limit: 60,
			windowMs: HOUR
		}
	];
}
function admitMemory(
	h: IdentityHost,
	charges: readonly Charge[],
	nowMs: number
): IdentityRefusal | null {
	const v = h.windows.charge(charges, nowMs);
	return v.ok ? null : refuse('rate_limited', RATE_LIMITED, v.retryAfter);
}
const retryAfter = (now: Date) => Math.ceil((HOUR - (now.getTime() % HOUR)) / 1000);
const codeMac = (keys: Keys, a: Address, code: string) =>
	to_hex(hmacSha256(keys.session, `${addressKey(a)}\u0000${code}`));
/** Six digits from the host's CSPRNG (38a(d)), unbiased by rejection. */
function sixDigits(): string {
	for (;;) {
		for (const n of crypto.getRandomValues(new Uint32Array(1)))
			if (n < 4294000000) return String(n % 1000000).padStart(6, '0');
	}
}
/** The sign-in mail's HTML body: tables and inline styles only, so every client renders it. `code` is our own six digits. */
const codeEmail = (code: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Your sign-in code</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px">
<tr><td style="padding:32px 32px 0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#18181b">Norbital</td></tr>
<tr><td style="padding:24px 32px 8px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#3f3f46">Your sign-in code is:</td></tr>
<tr><td style="padding:8px 32px;font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#18181b">${code}</td></tr>
<tr><td style="padding:8px 32px 32px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#52525b">It expires in 10 minutes. If you did not ask for this code, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
/** A newcomer may join by proving `a`: the workspace declares sign-up by that means and no administrator has closed it. */
const signupOpen = (
	h: IdentityHost,
	a: Address,
	config:
		| {
				readonly value?: unknown;
		  }
		| undefined
) => h.signup !== undefined && h.signup.via.includes(a.kind) && config?.value !== 'closed';
const SIGNUP_CONFIG = {
	text: `SELECT value FROM sys_config WHERE key = '${SIGNUP_KEY}'`,
	params: []
};
/** The open invitations addressed to `a`, newest first. */
const invitationsTo = (a: Address, now: Date) => ({
	text: `SELECT id, email, phone, team, external, party FROM sys_invitation WHERE ${a.kind === 'email' ? 'lower(email) = $1' : `regexp_replace(phone, '\\D', '', 'g') = $1`}
		AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2::timestamptz ORDER BY expires_at DESC LIMIT 1`,
	params: [member_value(a), now.toISOString()]
});
/**
 * Rule 38a(a–c): checks membership, an open invitation or self sign-up before persisting the challenge and sending
 * an email or asking the phone verifier to send by `via` (SMS unless WhatsApp is chosen). Ineligible addresses are
 * refused before the code step. The challenge carries our attempts and expiry for the verifier's code too.
 * A port refusal is returned; a fresh `send_code` is allowed at once. `human` is asked only for a stranger: where the
 * workspace challenges sign-up, it answers whether the caller passed.
 */
export const send_code = Effect.fn('Bolt.send_code')(function* (
	h: IdentityHost,
	typed: string,
	ip: string,
	via: 'sms' | 'whatsapp' = 'sms',
	human: Effect.Effect<boolean> = Effect.succeed(true)
) {
	const a = parse_address(typed);
	if (a === null) return yield* Effect.fail(refuse('check', ADDRESS_HINT));
	if (a.kind === 'phone' && h.phone?.via.includes(via) !== true)
		return yield* Effect.fail(
			refuse(
				'unavailable',
				`This workspace cannot send a code by ${via === 'sms' ? 'text' : 'WhatsApp'}.`
			)
		);
	const keys = yield* keysOf(h);
	const charges = preSignIn(keys, 'session.send_code', a, ip);
	const limited = admitMemory(h, charges, (yield* h.now).getTime());
	if (limited) return yield* Effect.fail(limited);
	const now = yield* h.now;
	const [users, invitations, config] = yield* h.db.read([
		{
			text: `SELECT active FROM sys_user WHERE ${member_column(a, '$1')}`,
			params: [member_value(a)]
		},
		invitationsTo(a, now),
		SIGNUP_CONFIG
	]);
	if (users === undefined || invitations === undefined || config === undefined)
		return yield* Effect.fail(DbError.make('XX000', 'The database did not answer the sign-in eligibility reads.'));
	const user = yield* identityRow(
		Schema.UndefinedOr(Schema.Struct({ active: Schema.Boolean })),
		users.rows[0]
	);
	if (user !== undefined && !user.active)
		return yield* Effect.fail(refuse('not_member', 'This member is deactivated.'));
	if (user === undefined && invitations.rows.length === 0) {
		if (!signupOpen(h, a, config.rows[0]))
			return yield* Effect.fail(
				refuse('not_member', 'This address has no invitation to this workspace.')
			);
		if (!(yield* human))
			return yield* Effect.fail(
				refuse('forbidden', 'Complete the security check on this page, then try again.')
			);
		if (a.kind === 'phone') {
			// a text to a stranger is paid for: sign-up texts are capped for the whole workspace (SMS pumping), and per
			// address so that one caller cannot use up the hour for everyone
			const signup: Charge[] = [
				{ rule: 'session.signup', bucket: 'workspace', limit: SIGNUP_TEXTS, windowMs: HOUR },
				{
					rule: 'session.signup',
					bucket: macKey(keys.ipMac, addressBucket(ip)),
					limit: SIGNUP_TEXTS_PER_IP,
					windowMs: HOUR
				}
			];
			const capped = admitMemory(h, signup, (yield* h.now).getTime());
			if (capped) return yield* Effect.fail(capped);
			charges.push(...signup);
		}
	}
	const code = h.dev_sink === true ? '123456' : sixDigits();
	const s = new IdentityStatement();
	const rate = ratePiece(s, charges, now.getTime());
	s.cte('ch', `INSERT INTO sys_challenge (address_mac, code_mac, attempts, expires_at)
	SELECT ${s.p(macKey(keys.ipMac, addressKey(a)))}, ${s.p(codeMac(keys, a, code))}, 0, ${s.p(new Date(now.getTime() + CODE_MS).toISOString())}::timestamptz
	WHERE ${rate}
	ON CONFLICT (address_mac) DO UPDATE SET code_mac = excluded.code_mac, attempts = 0, expires_at = excluded.expires_at RETURNING 1`);
	const saved = yield* nativeCommit(h.db.write, h.publication, s,
		Schema.Struct({ ...CapturedResult.fields, saved: Schema.Number }), '(SELECT count(*)::int FROM ch) AS saved');
	if (saved.saved !== 1)
		return yield* Effect.fail(refuse('rate_limited', RATE_LIMITED, retryAfter(now)));
	const sent =
		a.kind === 'email'
			? yield* identityPort('email', h.mail, LIMITS.callMs.other, (m, signal) =>
					m.send(
						'email',
						{
							to: a.value,
							subject: 'Your sign-in code',
							text: `Your sign-in code is ${code}. It expires in 10 minutes.`,
							html: codeEmail(code)
						},
						signal
					)
				)
			: yield* identityPort('phone', h.phone, LIMITS.callMs.other, (p, signal) =>
					p.start(a.value, via, signal).then(() => ({ provider_id: via }))
				);
	if (Result.isFailure(sent))
		return yield* Effect.fail(portRefusal(sent.failure, 'The code could not be sent.'));
	return null;
});
export type Session = {
	token: string;
	user: string;
	expiresAt: string;
};
export const InvitationSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	team: Schema.NullOr(Schema.String),
	external: Schema.Boolean,
	party: Schema.Json
});
export type Invitation = Schema.Schema.Type<typeof InvitationSchema>;
export const identityRow = <A>(schema: Schema.Decoder<A>, row: unknown) =>
	Schema.decodeUnknownEffect(schema)(row).pipe(
		Effect.mapError((error) => refuse('upstream', `The identity row is invalid: ${error.message}`))
	);
// ── member and invitation history ──
/** A historied identity mutation keeps its before/after projection in the same captured piece. */
export const identityPiece = (s: Chain, name: string, table: string, statement: string): string =>
	capturePiece(s, name, table, statement, { returning: (before, after) =>
		`coalesce(${after}.id, ${before}.id) AS id,
		CASE WHEN ${before}.id IS NULL THEN NULL ELSE to_jsonb(${before}) END AS o,
		CASE WHEN ${after}.id IS NULL THEN NULL ELSE to_jsonb(${after}) END AS n` });
/**
 * Images acquire their identity once, then the shared writer records their history and events; the automations
 * listening to `table` queue in the same statement, as for any model's write.
 */
export function identityHistory(
	s: IdentityStatement,
	table: 'sys_user' | 'sys_invitation',
	cte: string,
	at: Date,
	actor: string | null,
	writes: readonly WriteTrigger[] | undefined,
	depth: number
): void {
	const source = s.cte(
		`${cte}_changes`,
		`SELECT ${s.p(table)}::text AS c,id,
   coalesce((n->>'revision')::int,(o->>'revision')::int + 1) AS revision,${s.p(at.toISOString())}::timestamptz AS at,
   ${s.p(actor)}::text AS actor,CASE WHEN o IS NULL THEN 'create' WHEN n IS NULL THEN 'delete' ELSE 'update' END AS op,
   'direct'::text AS cause,false AS erased,o,n FROM ${cte}`
	);
	// identity writes run in the audited batch, which names its operation for the transaction
	history_piece(s, source, { operation: "nullif(current_setting('bolt.audit',true),'')" });
	const listening = (writes ?? []).filter((w) => w.model === table);
	if (listening.length > 0) queue_events(s, listening, `${s.p(at.toISOString())}::timestamptz`, source, depth);
}
/** The actor a history row names: `member:<id>` (as the write area's `actor_ref`), or the host. */
export const by = (auth: Authority | null): string =>
	auth !== null && auth.actor.kind === 'member' ? `member:${auth.actor.id}` : 'host';
export const MEMBERSHIP = 'bolt.membership';
/**
 * the piece that queues one `bolt.membership` run per `sys_user` row `cte` wrote where `gate`
 * holds, or nothing when the host binds no membership port.
 */
export function projection(
	h: IdentityHost,
	s: IdentityStatement,
	cte: string,
	now: Date,
	gate = 'true'
): boolean {
	if (h.membership === undefined) return false;
	const input = `jsonb_build_object('user', x.id, 'email', x.n->'email', 'phone', x.n->'phone', 'team', x.n->'team', 'state', CASE WHEN (x.n->>'active')::boolean THEN 'active' ELSE 'inactive' END)`;
	enqueue(s, {
		select: `SELECT ${s.p(MEMBERSHIP)}::text AS automation,
        ${input} AS input,${s.p(now.toISOString())}::timestamptz AS due_at,'platform'::text AS cause,0 AS depth
        FROM ${cte} x WHERE ${gate}`
	});
	return true;
}
/** After a verb whose statement may have queued `bolt.membership`: wake the queue now. */
export const announceMembership = (h: IdentityHost) =>
	Effect.gen(function* () {
		if (h.membership !== undefined) yield* h.membership.announce((yield* h.now).toISOString());
	});
/** A JSON value as a `::jsonb` parameter; SQL NULL for none. */
export const jsonb = (v: Json | undefined): Json =>
	v === null || v === undefined ? null : JSON.stringify(v);
/**
 * The CTEs that accept an invitation for `user`: the stamp (`accepted`, only while the invitation is open and `gate`
 * holds), the member (`member`: an update of an existing member, or the row `born` inserted in this statement, since a
 * CTE cannot see another's writes).
 */
export function acceptPieces(
	s: IdentityStatement,
	inv: Invitation,
	user: string,
	now: Date,
	gate: string,
	born: boolean,
	writes: readonly WriteTrigger[] | undefined
): void {
	const actor = `member:${user}`;
	identityPiece(s, 'accepted', 'sys_invitation', `UPDATE sys_invitation SET accepted_at = ${s.p(now.toISOString())}::timestamptz, revision = revision + 1
	WHERE ${openInvitation(s, inv.id, now)} AND ${gate}`);
	identityHistory(s, 'sys_invitation', 'accepted', now, actor, writes, 0);
	if (born) s.cte('member', 'SELECT id FROM born WHERE EXISTS (SELECT 1 FROM accepted)');
	else {
		identityPiece(s, 'member', 'sys_user', `UPDATE sys_user SET team = coalesce(${s.p(inv.team)}, team), kind = ${s.p(inv.external ? 'external' : 'staff')},
		party = ${s.p(jsonb(inv.party))}::jsonb, revision = revision + 1 WHERE id = ${s.p(user)} AND EXISTS (SELECT 1 FROM accepted)`);
		identityHistory(s, 'sys_user', 'member', now, actor, writes, 0);
	}
}
const openInvitation = (s: IdentityStatement, id: string, now: Date) =>
	`id = ${s.p(id)} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${s.p(now.toISOString())}::timestamptz`;
const sessionValues = (s: IdentityStatement, now: Date, via: string, hash: string, id: string) =>
	`${s.p(id)}, ${s.p(hash)}, ${s.p(via)}, ${s.p(now.toISOString())}::timestamptz, ${s.p(new Date(now.getTime() + SESSION_MS).toISOString())}::timestamptz, ${s.p(now.toISOString())}::timestamptz`;
const SESSION_COLUMNS = `(id, "user", token_hash, via, created_at, expires_at, refreshed_at)`;
/** Persist only non-credential session metadata; the bearer is assembled after its audit settles. */
const SessionOutcome = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('committed'),
		output: Schema.Struct({
			user: Schema.String,
			sessionId: Schema.String,
			expiresAt: Schema.String,
			count: Schema.Literal(1)
		})
	}),
	Schema.Struct({
		kind: Schema.Literal('refused'),
		code: Schema.Literals(['invalid_code', 'not_found', 'forbidden']),
		message: Schema.String
	})
]);
const SessionResult = Schema.Struct({ ...CapturedResult.fields, outcome: SessionOutcome });
const auditedIdentity = <O extends Json>(
	h: IdentityHost,
	s: IdentityStatement,
	intent: Omit<AuditIntent, 'category'>,
	schema: Schema.Decoder<typeof CapturedResult.Type & { readonly outcome: O }>,
	select: string,
	locks?: Lock
) => Effect.gen(function* () {
	const audit = h.audit ?? (yield* Audit);
	const write: TenantDb['write'] = locks === undefined
		? h.db.write
		: (statement) => h.db.write(statement, locks);
	return yield* audited(h.db, { category: 'identity', ...intent },
		nativeCommit(write, h.publication, s, schema, select).pipe(Effect.map((row) => row.outcome))
	).pipe(Effect.provideService(Audit, audit));
});
const sessionOutcome = (
	s: IdentityStatement,
	key: string,
	digest: string,
	code: 'invalid_code' | 'not_found' | 'forbidden',
	message: string
) => answer(
	s,
	key,
	digest,
	`CASE WHEN EXISTS (SELECT 1 FROM sess) THEN jsonb_build_object('kind','committed','output',
			(SELECT jsonb_build_object('user',"user",'sessionId',id,'expiresAt',expires_at::text,'count',1) FROM sess),
			'records','[]'::jsonb) ELSE ${s.p({ kind: 'refused', code, message })}::jsonb END`
	);
/** The records `signup.party` names for `a` (its match field holds the address); exactly one is the person. */
export const partyRow = (signup: Signup | undefined, a: Address) => {
	const field = signup?.party?.match[a.kind];
	if (signup?.party === undefined || field === undefined)
		return { text: 'SELECT NULL::text AS id WHERE false', params: [] };
	const column = `"${signup.party.model}"."${field}"`;
	return {
		text: `SELECT id::text AS id FROM "${signup.party.model}" WHERE ${a.kind === 'email' ? `lower(${column}) = $1` : `regexp_replace(${column}, '\\D', '', 'g') = $1`} LIMIT 2`,
		params: [member_value(a)]
	};
};
/**
 * Rule 38a(b): 3 attempts per code, compared in constant time, single use. Success mints a session for the member; for
 * an address with no member yet, it creates one in the same statement: accepting the open invitation to it, or, where
 * the workspace lets newcomers sign up by that means, as an external member holding `signup.policies` and bound to the
 * record that is them (a guest becomes a registered member). A member who signed up before their record existed is
 * bound to it at their next sign-in.
 */
export const verify_code = Effect.fn('Bolt.verify_code')(function* (
	h: IdentityHost,
	typed: string,
	code: string,
	ip: string,
	/** The caller's anonymous user (the visitor cookie's), linked to the account this proves; see `mergeAnonymous`. */
	anonymous: string | null = null
) {
	const a = parse_address(typed);
	if (a === null) return yield* Effect.fail(refuse('check', ADDRESS_HINT));
	const keys = yield* keysOf(h);
	const charges = preSignIn(keys, 'session.verify_code', a, ip);
	const limited = admitMemory(h, charges, (yield* h.now).getTime());
	if (limited) return yield* Effect.fail(limited);
	const now = yield* h.now,
		address = macKey(keys.ipMac, addressKey(a));
	const [challenges, users, invitations, config, parties] = yield* h.db.read([
		{
			text: 'SELECT code_mac, attempts, expires_at FROM sys_challenge WHERE address_mac = $1',
			params: [address]
		},
		{
			text: `SELECT id, active, kind, party FROM sys_user WHERE ${member_column(a, '$1')}`,
			params: [member_value(a)]
		},
		invitationsTo(a, now),
		SIGNUP_CONFIG,
		partyRow(h.signup, a)
	]);
	if (challenges === undefined || users === undefined || invitations === undefined || config === undefined || parties === undefined)
		return yield* Effect.fail(DbError.make('XX000', 'The database did not answer the sign-in verification reads.'));
	const ch = yield* identityRow(
		Schema.UndefinedOr(
			Schema.Struct({ code_mac: Schema.String, attempts: Schema.Number, expires_at: Schema.String })
		),
		challenges.rows[0]
	);
	if (ch === undefined || Date.parse(ch.expires_at) <= now.getTime())
		return yield* Effect.fail(refuse('invalid_code', 'The code is wrong or has expired.'));
	const s = new IdentityStatement();
	const rate = ratePiece(s, charges, now.getTime());
	// a number's code is the verifier's, checked there; an email's is ours, compared in constant time
	const checked =
		a.kind === 'email'
			? timingSafeEqual(
					fromHex(codeMac(keys, a, /^\d{6}$/.test(code) ? code : 'x')),
					fromHex(ch.code_mac)
				)
			: /^\d{6}$/.test(code) &&
				(yield* identityPort('phone', h.phone, LIMITS.callMs.other, (p, signal) =>
					p.check(a.value, code, signal)
				));
	if (typeof checked !== 'boolean' && Result.isFailure(checked))
		return yield* Effect.fail(portRefusal(checked.failure, 'The code could not be checked. Try again.'));
	if (checked === false || (typeof checked !== 'boolean' && checked.success === false)) {
		const at = s.p(address),
			n = s.p(ch.attempts);
		s.cte('bump', `UPDATE sys_challenge SET attempts = attempts + 1 WHERE address_mac = ${at} AND attempts = ${n} AND attempts + 1 < ${ATTEMPTS} RETURNING 1`);
		s.cte('gone', `DELETE FROM sys_challenge WHERE address_mac = ${at} AND attempts = ${n} AND attempts + 1 >= ${ATTEMPTS} RETURNING 1`);
		yield* nativeCommit(h.db.write, h.publication, s, CapturedResult);
		return yield* Effect.fail(refuse('invalid_code', 'The code is wrong or has expired.'));
	}
	const user = yield* identityRow(
		Schema.UndefinedOr(
			Schema.Struct({
				id: Schema.String,
				active: Schema.Boolean,
				kind: Schema.String,
				party: Schema.Json
			})
		),
		users.rows[0]
	);
	const inv = yield* identityRow(Schema.UndefinedOr(InvitationSchema), invitations.rows[0]);
	const signup = user === undefined && inv === undefined && signupOpen(h, a, config.rows[0]);
	// exactly one record is the person; two holding the same address name nobody
	const matched = parties.rows.length === 1
		? yield* identityRow(Schema.Struct({ id: Schema.NullOr(Schema.String) }), parties.rows[0])
		: undefined;
	const party = h.signup?.party !== undefined && matched?.id != null
			? { model: h.signup.party.model, id: matched.id, matched: true }
			: null;
	if (user !== undefined && !user.active)
		return yield* Effect.fail(refuse('not_member', 'This member is deactivated.'));
	if (user === undefined && inv === undefined && !signup)
		return yield* Effect.fail(
			refuse('not_member', 'This address has no invitation to this workspace.')
		);
	// a newcomer who was an anonymous visitor keeps that id: the anonymous user becomes the account, its rows with it
	const upgraded =
		user === undefined && anonymous !== null
			? Option.getOrNull(
					yield* h.db.one(Schema.Struct({ id: Schema.String }), {
						text: `SELECT id FROM sys_user WHERE id = $1 AND kind = 'anonymous' AND active`,
						params: [anonymous]
					})
				)?.id
			: undefined;
	const token = randomToken(),
		userId = user?.id ?? upgraded ?? (yield* newId(h.crypto)),
		sessionId = yield* newId(h.crypto);
	const born = user === undefined;
	/** The newcomer's row: inserted, or the anonymous user's, updated in place (`kind = 'anonymous'` guards the race). */
	const birth = (columns: { readonly [column: string]: string }, when: string) => {
		identityPiece(s, 'born', 'sys_user', upgraded === undefined
			? `INSERT INTO sys_user (id, ${Object.keys(columns).join(', ')})
	SELECT ${s.p(userId)}, ${Object.values(columns).join(', ')} WHERE ${when}`
			: `UPDATE sys_user SET ${Object.entries(columns)
					.map(([k, v]) => `${k} = ${v}`)
					.join(', ')}, revision = revision + 1
	WHERE id = ${s.p(userId)} AND kind = 'anonymous' AND active AND ${when}`);
		identityHistory(s, 'sys_user', 'born', now, `member:${userId}`, h.writes, 0);
		if (upgraded !== undefined)
			capturePiece(s, 'anonymous_sessions', 'sys_session', `DELETE FROM sys_session WHERE "user" IN (SELECT id FROM born) AND via = ${s.p(ANONYMOUS)}`);
	};
	const via = !born ? 'code' : signup ? 'signup' : 'invitation';
	const payload = {
		user: userId,
		sessionId,
		via,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + SESSION_MS).toISOString()
	};
	const outcomeKey = sha256(`identity:session.verify:${sessionId}`),
		digest = sha256(canonical(payload));
	gate(s, outcomeKey, digest, now.toISOString());
	s.cte('used', `DELETE FROM sys_challenge WHERE address_mac = ${s.p(address)} AND attempts = ${s.p(ch.attempts)} AND ${rate} AND ${GATED} RETURNING 1`);
	const email = a.kind === 'email' ? a.value : (inv?.email ?? null),
		phone = a.kind === 'phone' ? a.value : (inv?.phone ?? null);
	const name = defaultName(a);
	// parameters bind as they are named, so only a branch that writes the newcomer names their contact
	const contact = () => ({ email: s.p(email), phone: s.p(phone), name: s.p(name) });
	if (user === undefined && inv !== undefined) {
		birth(
			{
				...contact(),
				kind: s.p(inv.external ? 'external' : 'staff'),
				team: s.p(inv.team),
				party: `${s.p(jsonb(inv.party))}::jsonb`
			},
			`EXISTS (SELECT 1 FROM used) AND EXISTS (SELECT 1 FROM sys_invitation WHERE ${openInvitation(s, inv.id, now)})`
		);
		acceptPieces(s, inv, userId, now, 'EXISTS (SELECT 1 FROM born)', true, h.writes);
	} else if (signup) {
		birth(
			{ ...contact(), kind: `'external'`, party: `${s.p(jsonb(party))}::jsonb`, signup: 'true' },
			'EXISTS (SELECT 1 FROM used)'
		);
		s.cte('member', 'SELECT id FROM born');
	} else if (user?.kind === 'external' && user.party === null && party !== null) {
		identityPiece(s, 'bound', 'sys_user', `UPDATE sys_user SET party = ${s.p(jsonb(party))}::jsonb, revision = revision + 1
	WHERE id = ${s.p(userId)} AND party IS NULL AND EXISTS (SELECT 1 FROM used)`);
		identityHistory(s, 'sys_user', 'bound', now, `member:${userId}`, h.writes, 0);
	}
	// a member born by accepting an invitation or signing up is projected, in this statement
	const project = born && projection(h, s, 'born', now, signup ? 'true' : 'EXISTS (SELECT 1 FROM accepted)');
	capturePiece(s, 'sess', 'sys_session', `INSERT INTO sys_session ${SESSION_COLUMNS} SELECT v.id, ${s.p(userId)}, v.h, v.via, v.c, v.e, v.r
	FROM (VALUES (${sessionValues(s, now, via, sha256(token), sessionId)})) v(id, h, via, c, e, r)
	WHERE EXISTS (SELECT 1 FROM ${born ? 'member' : 'used'})`, { returning: 'id,"user",expires_at' });
	const result = sessionOutcome(
		s,
		outcomeKey,
		digest,
		'invalid_code',
		'The code is wrong or has expired.'
	);
	const out = yield* auditedIdentity(
		h,
		s,
		{
			action: 'session.verify',
			actor: { kind: 'member', id: userId, label: null },
			payload,
			outcomeKey,
			digest
		},
		SessionResult,
		result,
		lock(born)
	);
	if (out.kind === 'refused') return yield* Effect.fail(refuse(out.code, out.message));
	if (project) yield* announceMembership(h);
	return { token, user: out.output.user, expiresAt: new Date(out.output.expiresAt).toISOString() };
});
/**
 * A visitor's anonymous identity (Firebase-style anonymous sign-in): a `sys_user` of kind `anonymous` and one session,
 * whose token the visitor cookie holds. It slides for 30 days unused; the daily prune removes it after that.
 */
export const mintAnonymous = Effect.fn('Bolt.mintAnonymous')(function* (h: IdentityHost) {
	const now = yield* h.now,
		token = randomToken(),
		user = yield* newId(h.crypto),
		session = yield* newId(h.crypto),
		s = new IdentityStatement(),
		at = s.p(now.toISOString());
	identityPiece(s, 'born', 'sys_user', `INSERT INTO sys_user (id, name, kind) VALUES (${s.p(user)}, 'Anonymous', ${s.p(ANONYMOUS)})`);
	identityHistory(s, 'sys_user', 'born', now, `visitor:${user}`, h.writes, 0);
	capturePiece(s, 'sess', 'sys_session', `INSERT INTO sys_session ${SESSION_COLUMNS} SELECT ${s.p(session)}, id, ${s.p(sha256(token))}, ${s.p(ANONYMOUS)},
	${at}::timestamptz, ${s.p(new Date(now.getTime() + ANONYMOUS_MS).toISOString())}::timestamptz, ${at}::timestamptz FROM born`);
	yield* nativeCommit(h.db.write, h.publication, s, CapturedResult);
	return { token, user };
});
/**
 * Signing in to an account that already exists while holding an anonymous user (`from`): every `sys_user` ref of a
 * workspace model holding `from` moves to the account (`to`), except where the row's state locks that field, and the
 * anonymous user is retired (deactivated, its sessions gone; the prune deletes it once nothing references it). Text
 * copies of the id and `created_by` keep it. A refused move (a record under approval) moves nothing and is logged.
 */
export const mergeAnonymous = Effect.fn('Bolt.mergeAnonymous')(function* (
	h: IdentityHost,
	m: EngineManifest,
	from: string,
	to: string
) {
	const now = yield* h.now,
		s = new IdentityStatement(),
		anon = `(SELECT id FROM anon)`;
	s.cte('anon', `SELECT id FROM sys_user WHERE id = ${s.p(from)} AND kind = ${s.p(ANONYMOUS)} AND id <> ${s.p(to)}`);
	for (const [i, r] of relations(m).all.entries()) {
		if (r.targets.length !== 1 || r.targets[0] !== 'sys_user') continue;
		const locked: string[] = [];
		for (const rule of Object.values(m.models[r.from]?.locks ?? {}))
			if (!rule.except?.includes(r.fk)) locked.push(`(NOT ${yield* toOwnSql(m, r.from, rule.where, 't.', s, true)})`);
		capturePiece(s, `move_${i}`, r.from,
			`UPDATE "${r.from}" t SET "${r.fk}" = ${s.p(to)} WHERE t."${r.fk}" = ${anon}${locked.map((l) => ` AND ${l}`).join('')}`,
			{ image: (alias) => storedRowSql(catalog_of(m), r.from, alias) });
	}
	capturePiece(s, 'gone', 'sys_session', `DELETE FROM sys_session WHERE "user" = ${anon}`);
	identityPiece(s, 'retired', 'sys_user', `UPDATE sys_user SET active = false, revision = revision + 1 WHERE id = ${anon} AND active`);
	identityHistory(s, 'sys_user', 'retired', now, `member:${to}`, h.writes, 0);
	yield* nativeCommit(h.db.write, h.publication, s, CapturedResult)
		.pipe(
			Effect.catchTag('DbError', (error) =>
				Effect.logWarning('an anonymous user was not merged into its account', error)
			)
		);
});
const lock = (born: boolean): Lock | undefined =>
	born ? { advisory: ['sys_user.address'] } : undefined;
export const make_identity_host = Effect.fn('Bolt.identityHost')(function* (
	config: Omit<IdentityHost, 'crypto' | 'publication'>
) {
	const crypto = yield* Crypto.Crypto;
	// the host's own facility: a verb may be called outside the context that built it
	const audit = config.audit ?? (yield* Audit);
	const host: IdentityHost = { ...config, crypto, audit, publication: 'bootstrap' };
	return host;
});
/** Read the current session so a revocation from another activation applies to the next request. */
export const authenticate = Effect.fn('Bolt.authenticate')(function* (
	h: IdentityHost,
	token: string
) {
	const session = yield* lookup(h, sha256(token));
	if (session === null)
		return yield* Effect.fail(refuse('not_member', 'No active session.'));
	return session;
});
const lookup = Effect.fn('Bolt.lookup')(function* (
	h: Pick<IdentityHost, 'db' | 'now' | 'publication'>,
	hash: string
) {
	const now = yield* h.now;
	const [rows] = yield* h.db.read([
		{
			text: `SELECT s.id, s."user", s.impersonated_by, s.agent, s.via, s.refreshed_at, s.expires_at, u.last_seen FROM sys_session s JOIN sys_user u ON u.id = s."user"
		WHERE s.token_hash = $1 AND s.expires_at > $2::timestamptz AND u.active`,
			params: [hash, now.toISOString()]
		}
	]);
	const r = yield* identityRow(
		Schema.UndefinedOr(
			Schema.Struct({
				id: Schema.String,
				user: Schema.String,
				impersonated_by: Schema.NullOr(Schema.String),
				agent: Schema.NullOr(Schema.String),
				via: Schema.String,
				refreshed_at: Schema.String,
				expires_at: Schema.String,
				last_seen: Schema.NullOr(Schema.String)
			})
		),
		rows?.rows[0]
	);
	if (r === undefined) return null;
	if (
		r.via !== ANONYMOUS &&
		r.impersonated_by === null &&
		r.agent === null &&
		(r.last_seen === null || now.getTime() - Date.parse(r.last_seen) >= HOUR)
	) {
		const c = new Chain();
		capturePiece(c, 'seen', 'sys_user', `UPDATE sys_user SET last_seen = ${c.p(now.toISOString())}::timestamptz WHERE id = ${c.p(r.user)}`);
		yield* nativeCommit(h.db.write, h.publication, c, CapturedResult);
	}
	let expiresAt = Date.parse(r.expires_at);
	if (now.getTime() - Date.parse(r.refreshed_at) >= DAY) {
		expiresAt = now.getTime() + (r.via === ANONYMOUS ? ANONYMOUS_MS : SESSION_MS);
		const c = new Chain();
		capturePiece(c, 'refreshed', 'sys_session', `UPDATE sys_session SET refreshed_at = ${c.p(now.toISOString())}::timestamptz,
			expires_at = ${c.p(new Date(expiresAt).toISOString())}::timestamptz WHERE id = ${c.p(r.id)}`);
		yield* nativeCommit(h.db.write, h.publication, c, CapturedResult);
	}
	return {
		user: r.user,
		session: r.id,
		impersonatedBy: r.impersonated_by,
		agent: r.agent === null ? null : { conversation: r.agent },
		expiresAt
	};
});
/**
 * `session.mint { user }`: host authority only; refused unless the user exists and is active. `agent`: the
 * session is the agent's browser, acting for `user` in that conversation; every request made with it carries the mark.
 */
export const mint = Effect.fn('Bolt.mint')(function* (
	h: IdentityHost,
	user: string,
	agent?: NonNullable<Authority['agent']>
) {
	const now = yield* h.now,
		token = randomToken(),
		sessionId = yield* newId(h.crypto),
		s = new IdentityStatement();
	const payload = {
		user,
		sessionId,
		via: 'host',
		agent: agent?.conversation ?? null,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + SESSION_MS).toISOString()
	};
	const outcomeKey = sha256(`identity:session.mint:${sessionId}`),
		digest = sha256(canonical(payload));
	gate(s, outcomeKey, digest, now.toISOString());
	capturePiece(s, 'sess', 'sys_session', `INSERT INTO sys_session (id, "user", token_hash, via, created_at, expires_at, refreshed_at, agent)
	SELECT v.id, u.id, v.h, v.via, v.c, v.e, v.r, ${s.p(agent?.conversation ?? null)}::text FROM sys_user u, (VALUES (${sessionValues(s, now, 'host', sha256(token), sessionId)})) v(id, h, via, c, e, r)
	WHERE u.id = ${s.p(user)} AND u.active AND ${GATED}`, { returning: 'id,"user",expires_at' });
	const result = sessionOutcome(s, outcomeKey, digest, 'not_found', 'No active member.');
	const out = yield* auditedIdentity(
		h,
		s,
		{
			action: 'session.mint',
			actor: { kind: 'system', id: 'host', label: null },
			payload,
			outcomeKey,
			digest
		},
		SessionResult,
		result
	);
	if (out.kind === 'refused') return yield* Effect.fail(refuse(out.code, out.message));
	return { token, user: out.output.user, expiresAt: new Date(out.output.expiresAt).toISOString() };
});
/** Revoke only the presented session. Its opaque row id is audit metadata; its bearer and hash are not. */
export const revokeSession = Effect.fn('Bolt.revokeSession')(function* (
	h: IdentityHost,
	token: string
) {
	const hash = sha256(token);
	const session = yield* h.db.one(Schema.Struct({ id: Schema.String, user: Schema.String }), {
		text: 'SELECT id,"user" FROM sys_session WHERE token_hash=$1',
		params: [hash]
	});
	if (session._tag === 'None') return;
	const now = yield* h.now,
		op = yield* newId(h.crypto),
		s = new IdentityStatement();
	const payload = {
		user: session.value.user,
		sessionId: session.value.id,
		revokedAt: now.toISOString()
	};
	const outcomeKey = sha256(`identity:session.revoke:${op}`),
		digest = sha256(canonical(payload));
	gate(s, outcomeKey, digest, now.toISOString());
	capturePiece(s, 'gone', 'sys_session', `DELETE FROM sys_session WHERE id=${s.p(session.value.id)} AND token_hash=${s.p(hash)} AND ${GATED}`);
	const select = answer(
			s,
			outcomeKey,
			digest,
			`jsonb_build_object('kind','committed','output',jsonb_build_object('sessionId',${s.p(session.value.id)}::text,
			'count',(SELECT count(*)::int FROM gone)),'records','[]'::jsonb)`
		);
	yield* auditedIdentity(
		h,
		s,
		{
			action: 'session.revoke',
			actor: { kind: 'member', id: session.value.user, label: null },
			payload,
			outcomeKey,
			digest
		},
		Schema.Struct({ ...CapturedResult.fields, outcome: Schema.Struct({
							kind: Schema.Literal('committed'),
							output: Schema.Struct({
								sessionId: Schema.String,
								count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
							})
						}) }),
		select
	);
});
/** A new member's display name until they set one: an email's local part as words (`mei.ling.tan` → `Mei Ling Tan`), else the number. */
export const defaultName = (a: Address): string =>
	a.kind === 'phone'
		? a.value
		: a.value
				.slice(0, a.value.indexOf('@') < 0 ? a.value.length : a.value.indexOf('@'))
				.split(/[._+-]+/)
				.filter(Boolean)
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(' ') || a.value;
/**
 * `founder.bootstrap { address, name? }`: host only; creates the first admin and a session for the proven
 * address (an email or a mobile number); idempotent per address (a second call mints a session for the same member);
 * refused once another admin exists. A seeded active staff member keeps their identity when adopted as founder.
 */
export const founder_bootstrap = Effect.fn('Bolt.founder_bootstrap')(function* (
	h: IdentityHost,
	typed: string,
	name?: string
) {
	const a = parse_address(typed);
	if (a === null) return yield* Effect.fail(refuse('check', ADDRESS_HINT));
	const now = yield* h.now,
		token = randomToken(),
		s = new IdentityStatement(),
		id = yield* newId(h.crypto),
		sessionId = yield* newId(h.crypto);
	const payload = {
		address: { kind: a.kind, value: a.value },
		name: name ?? defaultName(a),
		sessionId,
		via: 'host',
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + SESSION_MS).toISOString()
	};
	const outcomeKey = sha256(`identity:founder.bootstrap:${sessionId}`),
		digest = sha256(canonical(payload));
	gate(s, outcomeKey, digest, now.toISOString());
	return yield* Effect.gen(function* () {
		s.cte('existing', `SELECT id FROM sys_user WHERE ${member_column(a, s.p(member_value(a)))} AND admin AND active`);
		identityPiece(s, 'ins', 'sys_user', `INSERT INTO sys_user (id, email, phone, name, kind, admin)
		SELECT ${s.p(id)}, ${s.p(a.kind === 'email' ? a.value : null)}, ${s.p(a.kind === 'phone' ? a.value : null)}, ${s.p(name ?? defaultName(a))}, 'staff', true
		WHERE NOT EXISTS (SELECT 1 FROM sys_user WHERE admin) AND ${GATED}
		ON CONFLICT (${a.kind === 'email' ? 'lower(email)' : 'phone_key'}) DO UPDATE
		SET admin = true, revision = sys_user.revision + 1
		WHERE sys_user.kind = 'staff' AND sys_user.active AND NOT EXISTS (SELECT 1 FROM sys_user WHERE admin)`);
		identityHistory(s, 'sys_user', 'ins', now, 'host', h.writes, 0);
		s.cte('u', 'SELECT id FROM existing UNION ALL SELECT id FROM ins');
		capturePiece(s, 'sess', 'sys_session', `INSERT INTO sys_session ${SESSION_COLUMNS} SELECT v.id, u.id, v.h, v.via, v.c, v.e, v.r
		FROM u, (VALUES (${sessionValues(s, now, 'host', sha256(token), sessionId)})) v(id, h, via, c, e, r)
		WHERE ${GATED}`, { returning: 'id,"user",expires_at' });
		const result = sessionOutcome(
			s,
			outcomeKey,
			digest,
			'forbidden',
			'This workspace already has an administrator.'
		);
		const out = yield* auditedIdentity(
			h,
			s,
			{
				action: 'founder.bootstrap',
				actor: { kind: 'system', id: 'host', label: null },
				payload,
				outcomeKey,
				digest
			},
			SessionResult,
			result,
			{ advisory: ['sys_user.admins'] }
		);
		if (out.kind === 'refused') return yield* Effect.fail(refuse(out.code, out.message));
		return {
			token,
			user: out.output.user,
			expiresAt: new Date(out.output.expiresAt).toISOString()
		};
	}).pipe(
		Effect.catch((err) =>
			Effect.gen(function* () {
				if (err instanceof DbError && err.sqlstate === '23505')
					return yield* Effect.fail(
						refuse('forbidden', 'This address already belongs to a member.')
					);
				return yield* Effect.fail(err);
			})
		)
	);
});
export const identityPort = <P, A>(
	name: string,
	port: P | undefined,
	wall: number,
	call: (port: P, signal: AbortSignal) => PromiseLike<A>
) =>
	Effect.result(
		port === undefined
			? Port.unavailable(name)
			: Port.attempt(name, (signal) => call(port, signal)).pipe(Port.call(name, wall))
	);
export const IdentityLive = Layer.effect(
	Identity,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDbService,
			live = yield* Live,
			activation = yield* Activation;
		const provided = yield* Effect.serviceOption(HostIdentity);
		if (Option.isSome(provided)) provided.value.publication = live.publish;
		const host = yield* make_identity_host({
			db,
			keys: lazyKeys(db),
			now: Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms))),
			windows: new Windows(),
			public_url: activation.public_url,
			signup: signup_of(manifest),
			writes: triggers_of(manifest).writes
		});
		const authorities = new Authorities(manifest, activation.release);
		host.publication = live.publish;
		return {
			authenticate: (token: string) =>
				authenticate(host, token).pipe(
					Effect.mapError((error) =>
						error instanceof IdentityRefusal ? error : refuse('upstream', error.message)
					)
				),
			authority: (
				holder: import('../access/authority.ts').Holder,
				key = JSON.stringify([holder.actor, holder.policies, holder.admin])
			) => authorities.compile(holder, key)
		};
	})
);
