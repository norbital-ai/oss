// Sessions and sign-in (§5.11.2, rules 38, 38a): a one-time code, emailed or texted, against a persisted challenge, sessions stored
// only as a SHA-256 of their token, the host operations `session.mint` and `founder.bootstrap` (§5.11.3). Every act is
// one write statement that also persists its rate increments; reads and pre-statement refusals are memory-only.
import type { Json } from '../../decl/values.ts';
import { Audit } from '../audit.ts';
import { audited } from '../audit-operation.ts';
import { fromHex, hmacSha256, timingSafeEqual, toBase64url } from '../crypto.ts';
import { canonical, sha256 as sha256Bytes, toHex } from '@norbital-ai/store';
import { addressBucket, macKey, ratePiece, type Charge, type RateWindows } from '../access/rate.ts';
import { LIMITS, type Authority, type Lock, type TransportPort } from '../contracts.ts';
import { Cache, Clock, Crypto, Effect, Layer, Result, Schema } from 'effect';
import type { EngineManifest } from '../manifest.ts';
import { TenantDb as TenantDbService, type TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { Activation, Identity, Manifest, type Authenticated } from '../services.ts';
import { Authorities } from './actor.ts';
import { RateWindows as Windows } from '../access/rate.ts';
import { Port } from '../port.ts';
import { DbError, IdentityRefusal } from '../errors.ts';
import { answer, Chain, GATED, gate } from '../write/sql.ts';
import { historyPiece } from '../write/commit.ts';
import { enqueue } from '../runs/queue.ts';
import { queueTriggered } from '../runs/queue.ts';
import {
	ADDRESS_HINT,
	addressKey,
	memberColumn,
	memberValue,
	parseAddress,
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
export const signupOf = (m: Pick<EngineManifest, 'workspace'>): Signup | undefined =>
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
 * The host's transactional messaging, its one injected messaging facility (the host picks the provider: Bird,
 * Twilio). `email` is required; without `sms` nobody is texted an invitation, without `phone` nobody signs in by number.
 */
export type TransactionalProvider = {
	email: TransportPort;
	sms?: TransportPort | undefined;
	phone?: PhoneVerifier | undefined;
};
/**
 * A local host's phone verifier: its own code, printed by `log` as `(sign-in code 123456)` (bolt dev, a local host,
 * tests). `fixed` is 38a(f)'s `123456`.
 */
export function loggedPhone(log: (line: string) => void, fixed = false): PhoneVerifier {
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
 * What identity needs from its host (its `TransactionalProvider`'s parts): `mail` sends emailed codes and
 * invitations, `sms` texted invitations, `phone` sends and checks a mobile number's code — without it, numbers
 * cannot sign in. `devSink` is `bolt dev` and the test kit only: the fixed code `123456` (38a(f)).
 */
export type IdentityHost = {
	readonly audit?: import('../audit.ts').AuditShape;
	crypto: Crypto.Crypto;
	events?: {
		manifest: EngineManifest;
		announce: Effect.Effect<void>;
	};
	db: TenantDb;
	now: Effect.Effect<Date>;
	sessions: Cache.Cache<string, Authenticated, DbError | IdentityRefusal>;
	windows: RateWindows;
	keys: Keys;
	mail?: TransportPort | undefined;
	sms?: TransportPort | undefined;
	phone?: PhoneVerifier | undefined;
	devSink?: boolean | undefined;
	publicUrl: string;
	/** The workspace's `signup` declaration; absent, only invited members join. */
	signup?: Signup | undefined;
	/**
	 * §5.11.3: present when the host binds the `membership` port. Member lifecycle verbs then queue `bolt.membership` in
	 * their statement, and `announce` wakes the run queue for it (rule 52a).
	 */
	membership?: {
		announce(at: string): Effect.Effect<void>;
	};
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
	readonly host: IdentityHost | undefined;
	readonly auditActor: import('../contracts.ts').EngineActor | undefined;
	private readonly fragments: string[] = [];
	constructor(host?: IdentityHost, actor?: import('../contracts.ts').EngineActor) {
		super();
		this.host = host;
		this.auditActor = actor;
	}
	override cte(name: string, body: string): string {
		this.fragments.push(`${name} AS (${body})`);
		return super.cte(name, body);
	}
	/** Fragments share this statement's parameters and run-queue naming registry. */
	pieces(build: (chain: Chain) => void): string {
		const start = this.fragments.length;
		build(this);
		return this.fragments.slice(start).join(',\n');
	}
}
export const sha256 = (s: string) => toHex(sha256Bytes(s));
const randomToken = () => toBase64url(crypto.getRandomValues(new Uint8Array(32)));
export const newId = (crypto: Crypto.Crypto) =>
	crypto.randomUUIDv4().pipe(
		Effect.mapError(() => refuse('unavailable', 'Secure random UUID generation failed.'))
	);
const HOUR = 3600000,
	DAY = 24 * HOUR;
const SESSION_MS = 7 * DAY;
const CODE_MS = 10 * 60000,
	ATTEMPTS = 3;
/** Texts to numbers that are not yet members, per workspace per hour: what open sign-up can cost at most. */
export const SIGNUP_TEXTS = 50;
export const requireAdmin = (auth: Authority): IdentityRefusal | null =>
	auth.admin && auth.actor.kind === 'member'
		? null
		: refuse('forbidden', 'Only an administrator can do this.');
/**
 * Rule 38a(e): the session secret and `ip_mac` are 32 host-random bytes, written with `ON CONFLICT DO NOTHING` and
 * re-read, so two cells racing agree. Existing persisted keys need no initialization write.
 */
const StoredKey = Schema.Struct({
	key: Schema.Literals(['session', 'ip_mac']),
	value: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/))
});
export const loadKeys = Effect.fn('Bolt.loadKeys')(function* (db: TenantDb) {
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
		const hex = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
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
// ── pre-sign-in limits (rule 38): constants, per address MAC and per IP MAC ──
function preSignIn(
	h: IdentityHost,
	rule: 'session.sendCode' | 'session.verifyCode',
	a: Address,
	ip: string
): Charge[] {
	return [
		{
			rule,
			bucket: macKey(h.keys.ipMac, addressKey(a)),
			limit: rule === 'session.sendCode' ? 5 : 20,
			windowMs: HOUR
		},
		{
			rule: 'session.ip',
			bucket: macKey(h.keys.ipMac, addressBucket(ip)),
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
	return v.ok ? null : refuse('rateLimited', 'Too many attempts. Try again later.', v.retryAfter);
}
const retryAfter = (now: Date) => Math.ceil((HOUR - (now.getTime() % HOUR)) / 1000);
const codeMac = (h: IdentityHost, a: Address, code: string) =>
	toHex(hmacSha256(h.keys.session, `${addressKey(a)}\u0000${code}`));
/** Six digits from the host's CSPRNG (38a(d)), unbiased by rejection. */
function sixDigits(): string {
	for (;;) {
		const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
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
	params: [memberValue(a), now.toISOString()]
});
/**
 * Rule 38a(a–c): persists the challenge (replacing any earlier one) and only then hands the code to the mail port (an
 * email) or has the phone verifier send its own by `via` (a mobile number; SMS unless WhatsApp is chosen), whether or
 * not the address is a member. The challenge still carries our attempts and expiry for the verifier's code. A text costs money and a stranger's
 * number is anyone's to type, so a number that is no member's, invited nor free to sign up is answered the same and
 * sent nothing. A port refusal is returned; a fresh `sendCode` is allowed at once.
 */
export const sendCode = Effect.fn('Bolt.sendCode')(function* (
	h: IdentityHost,
	typed: string,
	ip: string,
	via: 'sms' | 'whatsapp' = 'sms'
) {
	const a = parseAddress(typed);
	if (a === null) return yield* Effect.fail(refuse('check', ADDRESS_HINT));
	if (a.kind === 'phone' && h.phone?.via.includes(via) !== true)
		return yield* Effect.fail(
			refuse(
				'unavailable',
				`This workspace cannot send a code by ${via === 'sms' ? 'text' : 'WhatsApp'}.`
			)
		);
	const charges = preSignIn(h, 'session.sendCode', a, ip);
	const limited = admitMemory(h, charges, (yield* h.now).getTime());
	if (limited) return yield* Effect.fail(limited);
	if (a.kind === 'phone') {
		const now = yield* h.now;
		const [users, invitations, config] = yield* h.db.read([
			{
				text: `SELECT 1 FROM sys_user WHERE ${memberColumn(a, '$1')} AND active`,
				params: [memberValue(a)]
			},
			invitationsTo(a, now),
			SIGNUP_CONFIG
		]);
		if (users!.rows.length === 0 && invitations!.rows.length === 0) {
			if (!signupOpen(h, a, config!.rows[0])) return null;
			// a text to a stranger is paid for: sign-up texts are capped for the whole workspace (SMS pumping)
			const signup: Charge = {
				rule: 'session.signup',
				bucket: 'workspace',
				limit: SIGNUP_TEXTS,
				windowMs: HOUR
			};
			const capped = admitMemory(h, [signup], (yield* h.now).getTime());
			if (capped) return yield* Effect.fail(capped);
			charges.push(signup);
		}
	}
	const code = h.devSink === true ? '123456' : sixDigits();
	const now = yield* h.now;
	const s = new IdentityStatement(h);
	const rate = ratePiece(charges, now.getTime(), (value) => s.p(value));
	const saved = yield* h.db.write({
		params: s.params,
		text: `WITH ${rate.cte},
ch AS (INSERT INTO sys_challenge (address_mac, code_mac, attempts, expires_at)
	SELECT ${s.p(macKey(h.keys.ipMac, addressKey(a)))}, ${s.p(codeMac(h, a, code))}, 0, ${s.p(new Date(now.getTime() + CODE_MS).toISOString())}::timestamptz
	WHERE ${rate.admitted}
	ON CONFLICT (address_mac) DO UPDATE SET code_mac = excluded.code_mac, attempts = 0, expires_at = excluded.expires_at RETURNING 1)
SELECT count(*)::int AS saved FROM ch`
	});
	if (saved.rows[0]!.saved !== 1)
		return yield* Effect.fail(
			refuse('rateLimited', 'Too many attempts. Try again later.', retryAfter(now))
		);
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
					p.start(a.value, via, signal).then(() => ({ providerId: via }))
				);
	if (Result.isFailure(sent))
		return yield* Effect.fail(
			refuse(
				sent.failure._tag === 'Unavailable'
					? 'unavailable'
					: sent.failure.kind === 'timeout'
						? 'timeout'
						: 'upstream',
				'The code could not be sent.'
			)
		);
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
/** The RETURNING of a CTE that writes a historied identity table: its id and both images. */
export const IMAGES = `RETURNING coalesce(new.id, old.id) AS id, CASE WHEN old.id IS NULL THEN NULL ELSE to_jsonb(old) END AS o,
	CASE WHEN new.id IS NULL THEN NULL ELSE to_jsonb(new) END AS n`;
/** Images acquire their identity once, then the shared writer records their history and events. */
export function identityHistory(
	s: IdentityStatement,
	table: 'sys_user' | 'sys_invitation',
	cte: string,
	at: Date,
	actor: string | null
): string {
	return s.pieces((chain) => {
		const source = chain.cte(
			`${cte}_changes`,
			`SELECT ${chain.p(table)}::text AS c,id,
   coalesce((n->>'revision')::int,(o->>'revision')::int + 1) AS revision,${chain.p(at.toISOString())}::timestamptz AS at,
   ${chain.p(actor)}::text AS actor,CASE WHEN o IS NULL THEN 'create' WHEN n IS NULL THEN 'delete' ELSE 'update' END AS op,
   'direct'::text AS cause,false AS erased,o,n FROM ${cte}`
		);
		historyPiece(chain, source);
		if (s.host?.events !== undefined)
			queueTriggered(s.host.events.manifest, chain, at.toISOString(), actor ?? 'host', source);
	});
}
/** The actor a history row names: `member:<id>` (as the write area's `actorRef`), or the host. */
export const by = (auth: Authority | null): string =>
	auth !== null && auth.actor.kind === 'member' ? `member:${auth.actor.id}` : 'host';
export const MEMBERSHIP = 'bolt.membership';
/**
 * §5.11.3: the piece that queues one `bolt.membership` run per `sys_user` row `cte` wrote (its `IMAGES`) where `gate`
 * holds, or nothing when the host binds no membership port.
 */
export function projection(
	h: IdentityHost,
	s: IdentityStatement,
	cte: string,
	now: Date,
	gate = 'true'
): string {
	if (h.membership === undefined) return '';
	const input = `jsonb_build_object('user', x.id, 'email', x.n->'email', 'phone', x.n->'phone', 'team', x.n->'team', 'state', CASE WHEN (x.n->>'active')::boolean THEN 'active' ELSE 'inactive' END)`;
	return (
		',\n' +
		s.pieces((chain) =>
			enqueue(chain, {
				select: `SELECT ${chain.p(MEMBERSHIP)}::text AS automation,
        ${input} AS input,${chain.p(now.toISOString())}::timestamptz AS due_at,'platform'::text AS cause,0 AS depth
        FROM ${cte} x WHERE ${gate}`
			})
		)
	);
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
	born: boolean
): string {
	const actor = `member:${user}`;
	const member = born
		? `member AS (SELECT id FROM born WHERE EXISTS (SELECT 1 FROM accepted))`
		: `member AS (UPDATE sys_user SET team = coalesce(${s.p(inv.team)}, team), kind = ${s.p(inv.external ? 'external' : 'staff')},
	party = ${s.p(jsonb(inv.party))}::jsonb, revision = revision + 1 WHERE id = ${s.p(user)} AND EXISTS (SELECT 1 FROM accepted) ${IMAGES}),
${identityHistory(s, 'sys_user', 'member', now, actor)}`;
	return `accepted AS (UPDATE sys_invitation SET accepted_at = ${s.p(now.toISOString())}::timestamptz, revision = revision + 1
	WHERE ${openInvitation(s, inv.id, now)} AND ${gate} ${IMAGES}),
${identityHistory(s, 'sys_invitation', 'accepted', now, actor)},
${member}`;
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
		code: Schema.Literals(['invalidCode', 'notFound', 'forbidden']),
		message: Schema.String
	})
]);
const sessionOutcome = (
	s: IdentityStatement,
	key: string,
	digest: string,
	code: 'invalidCode' | 'notFound' | 'forbidden',
	message: string
) => {
	let select = '';
	const cte = s.pieces((chain) => {
		select = answer(
			chain,
			key,
			digest,
			`CASE WHEN EXISTS (SELECT 1 FROM sess) THEN jsonb_build_object('kind','committed','output',
			(SELECT jsonb_build_object('user',"user",'sessionId',id,'expiresAt',expires_at::text,'count',1) FROM sess),
			'records','[]'::jsonb) ELSE ${s.p({ kind: 'refused', code, message })}::jsonb END`
		);
	});
	return { cte, select };
};
/** The records `signup.party` names for `a` (its match field holds the address); exactly one is the person. */
export const partyRow = (signup: Signup | undefined, a: Address) => {
	const field = signup?.party?.match[a.kind];
	if (signup?.party === undefined || field === undefined)
		return { text: 'SELECT NULL::text AS id WHERE false', params: [] };
	const column = `"${signup.party.model}"."${field}"`;
	return {
		text: `SELECT id::text AS id FROM "${signup.party.model}" WHERE ${a.kind === 'email' ? `lower(${column}) = $1` : `regexp_replace(${column}, '\\D', '', 'g') = $1`} LIMIT 2`,
		params: [memberValue(a)]
	};
};
/**
 * Rule 38a(b): 3 attempts per code, compared in constant time, single use. Success mints a session for the member; for
 * an address with no member yet, it creates one in the same statement: accepting the open invitation to it, or, where
 * the workspace lets newcomers sign up by that means, as an external member holding `signup.policies` and bound to the
 * record that is them (a guest becomes a registered member). A member who signed up before their record existed is
 * bound to it at their next sign-in.
 */
export const verifyCode = Effect.fn('Bolt.verifyCode')(function* (
	h: IdentityHost,
	typed: string,
	code: string,
	ip: string
) {
	const a = parseAddress(typed);
	if (a === null) return yield* Effect.fail(refuse('check', ADDRESS_HINT));
	const charges = preSignIn(h, 'session.verifyCode', a, ip);
	const limited = admitMemory(h, charges, (yield* h.now).getTime());
	if (limited) return yield* Effect.fail(limited);
	const now = yield* h.now,
		address = macKey(h.keys.ipMac, addressKey(a));
	const [challenges, users, invitations, config, parties] = yield* h.db.read([
		{
			text: 'SELECT code_mac, attempts, expires_at FROM sys_challenge WHERE address_mac = $1',
			params: [address]
		},
		{
			text: `SELECT id, active, kind, party FROM sys_user WHERE ${memberColumn(a, '$1')}`,
			params: [memberValue(a)]
		},
		invitationsTo(a, now),
		SIGNUP_CONFIG,
		partyRow(h.signup, a)
	]);
	const ch = yield* identityRow(
		Schema.UndefinedOr(
			Schema.Struct({ code_mac: Schema.String, attempts: Schema.Number, expires_at: Schema.String })
		),
		challenges!.rows[0]
	);
	if (ch === undefined || Date.parse(ch.expires_at) <= now.getTime())
		return yield* Effect.fail(refuse('invalidCode', 'The code is wrong or has expired.'));
	const s = new IdentityStatement(h);
	const rate = ratePiece(charges, now.getTime(), (value) => s.p(value));
	// a number's code is the verifier's, checked there; an email's is ours, compared in constant time
	const checked =
		a.kind === 'email'
			? timingSafeEqual(
					fromHex(codeMac(h, a, /^\d{6}$/.test(code) ? code : 'x')),
					fromHex(ch.code_mac)
				)
			: /^\d{6}$/.test(code) &&
				(yield* identityPort('phone', h.phone, LIMITS.callMs.other, (p, signal) =>
					p.check(a.value, code, signal)
				));
	if (typeof checked !== 'boolean' && Result.isFailure(checked))
		return yield* Effect.fail(
			refuse(
				checked.failure._tag === 'Unavailable'
					? 'unavailable'
					: checked.failure.kind === 'timeout'
						? 'timeout'
						: 'upstream',
				'The code could not be checked. Try again.'
			)
		);
	if (checked === false || (typeof checked !== 'boolean' && checked.success === false)) {
		const at = s.p(address),
			n = s.p(ch.attempts);
		yield* h.db.write({
			params: s.params,
			text: `WITH ${rate.cte},
bump AS (UPDATE sys_challenge SET attempts = attempts + 1 WHERE address_mac = ${at} AND attempts = ${n} AND attempts + 1 < ${ATTEMPTS} RETURNING 1),
gone AS (DELETE FROM sys_challenge WHERE address_mac = ${at} AND attempts = ${n} AND attempts + 1 >= ${ATTEMPTS} RETURNING 1)
SELECT 1`
		});
		return yield* Effect.fail(refuse('invalidCode', 'The code is wrong or has expired.'));
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
		users!.rows[0]
	);
	const inv = yield* identityRow(Schema.UndefinedOr(InvitationSchema), invitations!.rows[0]);
	const signup = user === undefined && inv === undefined && signupOpen(h, a, config!.rows[0]);
	// exactly one record is the person; two holding the same address name nobody
	const party =
		parties!.rows.length === 1
			? { model: h.signup!.party!.model, id: String(parties!.rows[0]!.id) }
			: null;
	if (user !== undefined && !user.active)
		return yield* Effect.fail(refuse('notMember', 'This member is deactivated.'));
	if (user === undefined && inv === undefined && !signup)
		return yield* Effect.fail(
			refuse('notMember', 'This address has no invitation to this workspace.')
		);
	const token = randomToken(),
		userId = user?.id ?? (yield* newId(h.crypto)),
		sessionId = yield* newId(h.crypto);
	const born = user === undefined;
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
	const admission = s.pieces((chain) => gate(chain, outcomeKey, digest, now.toISOString()));
	const used = `used AS (DELETE FROM sys_challenge WHERE address_mac = ${s.p(address)} AND attempts = ${s.p(ch.attempts)} AND ${rate.admitted} AND ${GATED} RETURNING 1)`;
	const pieces = [admission, rate.cte, used];
	const email = a.kind === 'email' ? a.value : (inv?.email ?? null),
		phone = a.kind === 'phone' ? a.value : (inv?.phone ?? null);
	const name = defaultName(a);
	if (user === undefined && inv !== undefined) {
		pieces.push(`born AS (INSERT INTO sys_user (id, email, phone, name, kind, team, party)
	SELECT ${s.p(userId)}, ${s.p(email)}, ${s.p(phone)}, ${s.p(name)}, ${s.p(inv.external ? 'external' : 'staff')}, ${s.p(inv.team)}, ${s.p(jsonb(inv.party))}::jsonb
	WHERE EXISTS (SELECT 1 FROM used) AND EXISTS (SELECT 1 FROM sys_invitation WHERE ${openInvitation(s, inv.id, now)}) ${IMAGES}),
${identityHistory(s, 'sys_user', 'born', now, `member:${userId}`)}`);
		pieces.push(acceptPieces(s, inv, userId, now, 'EXISTS (SELECT 1 FROM born)', true));
	} else if (signup) {
		pieces.push(`born AS (INSERT INTO sys_user (id, email, phone, name, kind, party, signup)
	SELECT ${s.p(userId)}, ${s.p(email)}, ${s.p(phone)}, ${s.p(name)}, 'external', ${s.p(jsonb(party))}::jsonb, true
	WHERE EXISTS (SELECT 1 FROM used) ${IMAGES}),
${identityHistory(s, 'sys_user', 'born', now, `member:${userId}`)},
member AS (SELECT id FROM born)`);
	} else if (user!.kind === 'external' && user!.party === null && party !== null) {
		pieces.push(`bound AS (UPDATE sys_user SET party = ${s.p(jsonb(party))}::jsonb, revision = revision + 1
	WHERE id = ${s.p(userId)} AND party IS NULL AND EXISTS (SELECT 1 FROM used) ${IMAGES}),
${identityHistory(s, 'sys_user', 'bound', now, `member:${userId}`)}`);
	}
	// §5.11.3: a member born by accepting an invitation or signing up is projected, in this statement
	const project = born
		? projection(h, s, 'born', now, signup ? 'true' : 'EXISTS (SELECT 1 FROM accepted)')
		: '';
	const result = sessionOutcome(
		s,
		outcomeKey,
		digest,
		'invalidCode',
		'The code is wrong or has expired.'
	);
	const audit = h.audit ?? (yield* Audit);
	const out = yield* audited(
		h.db,
		{
			category: 'identity',
			action: 'session.verify',
			actor: { kind: 'member', id: userId, label: null },
			payload,
			outcomeKey,
			digest
		},
		h.db
			.write(
				{
					params: s.params,
					text: `WITH ${pieces.join(',\n')}${project},
sess AS (INSERT INTO sys_session ${SESSION_COLUMNS} SELECT v.id, ${s.p(userId)}, v.h, v.via, v.c, v.e, v.r
	FROM (VALUES (${sessionValues(s, now, via, sha256(token), sessionId)})) v(id, h, via, c, e, r)
	WHERE EXISTS (SELECT 1 FROM ${born ? 'member' : 'used'}) RETURNING id,"user",expires_at),
${result.cte} SELECT ${result.select}`
				},
				lock(born)
			)
			.pipe(Effect.flatMap((rows) => identityRow(SessionOutcome, rows.rows[0]?.outcome)))
	).pipe(Effect.provideService(Audit, audit));
	if (out.kind === 'refused') return yield* Effect.fail(refuse(out.code, out.message));
	if (project !== '') yield* announceMembership(h);
	if (h.events !== undefined) yield* h.events.announce;
	return { token, user: out.output.user, expiresAt: new Date(out.output.expiresAt).toISOString() };
});
const lock = (born: boolean): Lock | undefined =>
	born ? { advisory: ['sys_user.address'] } : undefined;
const MEMO_MS = 30000,
	MEMO_MAX = 10000;
export const makeIdentityHost = Effect.fn('Bolt.identityHost')(function* (
	config: Omit<IdentityHost, 'sessions' | 'crypto'>
) {
	const crypto = yield* Crypto.Crypto;
	// the host's own facility: a verb may be called outside the context that built it
	const audit = config.audit ?? (yield* Audit);
	const sessions = yield* Cache.make({
		capacity: MEMO_MAX,
		timeToLive: MEMO_MS,
		lookup: (hash: string) =>
			lookup(config, hash).pipe(
				Effect.flatMap((session) =>
					session === null
						? Effect.fail(refuse('notMember', 'No active session.'))
						: Effect.succeed(session)
				)
			)
	});
	return { ...config, crypto, sessions, audit };
});
export const forget = (h: IdentityHost, token: string) =>
	Cache.invalidate(h.sessions, sha256(token));
/** The caller's activation cache retains successes for at most thirty seconds and never past expiry. */
export const authenticate = Effect.fn('Bolt.authenticate')(function* (
	h: IdentityHost,
	token: string
) {
	const hash = sha256(token);
	const session = yield* Cache.get(h.sessions, hash).pipe(
		Effect.tapError(() => Cache.invalidate(h.sessions, hash))
	);
	const now = yield* h.now;
	if (session.expiresAt <= now.getTime()) {
		yield* Cache.invalidate(h.sessions, hash);
		return yield* Effect.fail(refuse('notMember', 'No active session.'));
	}
	return session;
});
const lookup = Effect.fn('Bolt.lookup')(function* (
	h: Pick<IdentityHost, 'db' | 'now'>,
	hash: string
) {
	const now = yield* h.now;
	const [rows] = yield* h.db.read([
		{
			text: `SELECT s.id, s."user", s.impersonated_by, s.agent, s.refreshed_at, s.expires_at FROM sys_session s JOIN sys_user u ON u.id = s."user"
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
				refreshed_at: Schema.String,
				expires_at: Schema.String
			})
		),
		rows!.rows[0]
	);
	if (r === undefined) return null;
	let expiresAt = Date.parse(String(r.expires_at));
	if (now.getTime() - Date.parse(r.refreshed_at) >= DAY) {
		expiresAt = now.getTime() + SESSION_MS;
		yield* h.db.write({
			text: `UPDATE sys_session SET refreshed_at = $2::timestamptz, expires_at = $3::timestamptz WHERE id = $1`,
			params: [r.id, now.toISOString(), new Date(expiresAt).toISOString()]
		});
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
 * `session.mint { user }` (§5.11.3): host authority only; refused unless the user exists and is active. `agent`: the
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
		s = new IdentityStatement(h);
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
	const admission = s.pieces((chain) => gate(chain, outcomeKey, digest, now.toISOString()));
	const result = sessionOutcome(s, outcomeKey, digest, 'notFound', 'No active member.');
	const audit = h.audit ?? (yield* Audit);
	const out = yield* audited(
		h.db,
		{
			category: 'identity',
			action: 'session.mint',
			actor: { kind: 'system', id: 'host', label: null },
			payload,
			outcomeKey,
			digest
		},
		h.db
			.write({
				params: s.params,
				text: `WITH ${admission},
sess AS (INSERT INTO sys_session (id, "user", token_hash, via, created_at, expires_at, refreshed_at, agent)
SELECT v.id, u.id, v.h, v.via, v.c, v.e, v.r, ${s.p(agent?.conversation ?? null)}::text FROM sys_user u, (VALUES (${sessionValues(s, now, 'host', sha256(token), sessionId)})) v(id, h, via, c, e, r)
WHERE u.id = ${s.p(user)} AND u.active AND ${GATED} RETURNING id,"user",expires_at),
${result.cte} SELECT ${result.select}`
			})
			.pipe(Effect.flatMap((rows) => identityRow(SessionOutcome, rows.rows[0]?.outcome)))
	).pipe(Effect.provideService(Audit, audit));
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
	if (session._tag === 'None') {
		yield* forget(h, token);
		return;
	}
	const now = yield* h.now,
		op = yield* newId(h.crypto),
		s = new IdentityStatement(h);
	const payload = {
		user: session.value.user,
		sessionId: session.value.id,
		revokedAt: now.toISOString()
	};
	const outcomeKey = sha256(`identity:session.revoke:${op}`),
		digest = sha256(canonical(payload));
	const admission = s.pieces((chain) => gate(chain, outcomeKey, digest, now.toISOString()));
	let select = '';
	const result = s.pieces((chain) => {
		select = answer(
			chain,
			outcomeKey,
			digest,
			`jsonb_build_object('kind','committed','output',jsonb_build_object('sessionId',${s.p(session.value.id)}::text,
			'count',(SELECT count(*)::int FROM gone)),'records','[]'::jsonb)`
		);
	});
	const audit = h.audit ?? (yield* Audit);
	yield* audited(
		h.db,
		{
			category: 'identity',
			action: 'session.revoke',
			actor: { kind: 'member', id: session.value.user, label: null },
			payload,
			outcomeKey,
			digest
		},
		h.db
			.write({
				text: `WITH ${admission},
gone AS (DELETE FROM sys_session WHERE id=${s.p(session.value.id)} AND token_hash=${s.p(hash)} AND ${GATED} RETURNING id),
${result} SELECT ${select}`,
				params: s.params
			})
			.pipe(
				Effect.flatMap((rows) =>
					identityRow(
						Schema.Struct({
							kind: Schema.Literal('committed'),
							output: Schema.Struct({
								sessionId: Schema.String,
								count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
							})
						}),
						rows.rows[0]?.outcome
					)
				)
			)
	).pipe(Effect.provideService(Audit, audit));
	yield* forget(h, token);
});
/** A new member's display name until they set one: an email's local part as words (`mei.ling.tan` → `Mei Ling Tan`), else the number. */
export const defaultName = (a: Address): string =>
	a.kind === 'phone'
		? a.value
		: a.value
				.split('@')[0]!
				.split(/[._+-]+/)
				.filter(Boolean)
				.map((w) => w[0]!.toUpperCase() + w.slice(1))
				.join(' ') || a.value;
/**
 * `founder.bootstrap { address, name? }` (§5.11.3): host only; creates the first admin and a session for the proven
 * address (an email or a mobile number); idempotent per address (a second call mints a session for the same member);
 * refused once another admin exists.
 */
export const founderBootstrap = Effect.fn('Bolt.founderBootstrap')(function* (
	h: IdentityHost,
	typed: string,
	name?: string
) {
	const a = parseAddress(typed);
	if (a === null) return yield* Effect.fail(refuse('check', ADDRESS_HINT));
	const now = yield* h.now,
		token = randomToken(),
		s = new IdentityStatement(h),
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
	const admission = s.pieces((chain) => gate(chain, outcomeKey, digest, now.toISOString()));
	return yield* Effect.gen(function* () {
		const history = identityHistory(s, 'sys_user', 'ins', now, 'host');
		const result = sessionOutcome(
			s,
			outcomeKey,
			digest,
			'forbidden',
			'This workspace already has an administrator.'
		);
		const audit = h.audit ?? (yield* Audit);
		const out = yield* audited(
			h.db,
			{
				category: 'identity',
				action: 'founder.bootstrap',
				actor: { kind: 'system', id: 'host', label: null },
				payload,
				outcomeKey,
				digest
			},
			h.db
				.write(
					{
						params: s.params,
						text: `WITH ${admission}, existing AS (SELECT id FROM sys_user WHERE ${memberColumn(a, s.p(memberValue(a)))} AND admin AND active),
ins AS (INSERT INTO sys_user (id, email, phone, name, kind, admin)
	SELECT ${s.p(id)}, ${s.p(a.kind === 'email' ? a.value : null)}, ${s.p(a.kind === 'phone' ? a.value : null)}, ${s.p(name ?? defaultName(a))}, 'staff', true
	WHERE NOT EXISTS (SELECT 1 FROM sys_user WHERE admin) AND ${GATED} ${IMAGES}),
${history},
u AS (SELECT id FROM existing UNION ALL SELECT id FROM ins),
sess AS (INSERT INTO sys_session ${SESSION_COLUMNS} SELECT v.id, u.id, v.h, v.via, v.c, v.e, v.r
	FROM u, (VALUES (${sessionValues(s, now, 'host', sha256(token), sessionId)})) v(id, h, via, c, e, r)
	WHERE ${GATED} RETURNING id,"user",expires_at),
${result.cte} SELECT ${result.select}`
					},
					{ advisory: ['sys_user.admins'] }
				)
				.pipe(Effect.flatMap((rows) => identityRow(SessionOutcome, rows.rows[0]?.outcome)))
		).pipe(Effect.provideService(Audit, audit));
		if (out.kind === 'refused') return yield* Effect.fail(refuse(out.code, out.message));
		if (h.events !== undefined) yield* h.events.announce;
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
			activation = yield* Activation;
		const keys = yield* loadKeys(db);
		const host = yield* makeIdentityHost({
			db,
			keys,
			now: Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms))),
			windows: new Windows(),
			publicUrl: activation.publicUrl,
			signup: signupOf(manifest)
		});
		const authorities = new Authorities(manifest, activation.release);
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
			) => Effect.sync(() => authorities.compile(holder, key))
		};
	})
);
