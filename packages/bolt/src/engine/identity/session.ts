// Sessions and sign-in (§5.11.2, rules 38, 38a): an emailed one-time code against a persisted challenge, sessions stored
// only as a SHA-256 of their token, the host operations `session.mint` and `founder.bootstrap` (§5.11.3). Every act is
// one write statement that also persists its rate increments; reads and pre-statement refusals are memory-only.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import { addressBucket, macKey, ratePiece, type Charge, type RateWindows } from '../access/rate.ts';
import { callPort, DbError, LIMITS, type Authority, type Lock, type TenantDb, type TransportPort } from '../contracts.ts';

/** What identity needs from its host. `devSink` is `bolt dev` and the test kit only: the fixed code `123456` (38a(f)). */
export type IdentityHost = {
	db: TenantDb; now: () => Date; windows: RateWindows; keys: Keys;
	mail?: TransportPort; devSink?: boolean; publicUrl: string;
	/**
	 * §5.11.3: present when the host binds the `membership` port. Member lifecycle verbs then queue `bolt.membership` in
	 * their statement, and `announce` wakes the run queue for it (rule 52a).
	 */
	membership?: { announce(at: string): void };
};
export type Keys = { session: Buffer; ipMac: Buffer };
export type IdentityRefusal = 'forbidden' | 'notFound' | 'rateLimited' | 'expired' | 'lastAdmin' | 'active' | 'check'
	| 'invalidCode' | 'notMember' | 'unavailable' | 'upstream' | 'timeout';
export type Result<T> = { ok: true; value: T } | { ok: false; code: IdentityRefusal; message: string; retryAfter?: number };
export const refuse = (code: IdentityRefusal, message: string, retryAfter?: number): Result<never> =>
	({ ok: false, code, message, ...(retryAfter === undefined ? {} : { retryAfter }) });
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/** A statement under construction: `p(v)` binds a parameter and returns its placeholder. */
export function stmt() {
	const params: Json[] = [];
	return { params, p: (v: Json) => { params.push(v); return `$${params.length}`; } };
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
export const newId = () => crypto.randomUUID();
const addressOf = (email: string) => email.trim().toLowerCase();
const HOUR = 3_600_000, DAY = 24 * HOUR;
export const SESSION_MS = 7 * DAY;
const CODE_MS = 10 * 60_000, ATTEMPTS = 3;
export const requireAdmin = (auth: Authority): Result<never> | null =>
	auth.admin && auth.actor.kind === 'member' ? null : refuse('forbidden', 'Only an administrator can do this.');

/**
 * Rule 38a(e): the session secret and `ip_mac` are 32 host-random bytes, written with `ON CONFLICT DO NOTHING` and
 * re-read, so two cells racing agree.
 */
export async function loadKeys(db: TenantDb): Promise<Keys> {
	const hex = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
	await db.write({ text: `INSERT INTO sys_config (key, value) VALUES ('session', $1), ('ip_mac', $2) ON CONFLICT (key) DO NOTHING`, params: [hex(), hex()] });
	const [rows] = await db.read([{ text: `SELECT key, value FROM sys_config WHERE key IN ('session', 'ip_mac')`, params: [] }]);
	const get = (k: string) => Buffer.from(String(rows!.rows.find((r) => r.key === k)!.value), 'hex');
	return { session: get('session'), ipMac: get('ip_mac') };
}

// ── pre-sign-in limits (rule 38): constants, per address MAC and per IP MAC ──
function preSignIn(h: IdentityHost, rule: 'session.sendCode' | 'session.verifyCode', email: string, ip: string): Charge[] {
	return [
		{ rule, bucket: macKey(h.keys.ipMac, addressOf(email)), limit: rule === 'session.sendCode' ? 5 : 20, windowMs: HOUR },
		{ rule: 'session.ip', bucket: macKey(h.keys.ipMac, addressBucket(ip)), limit: 60, windowMs: HOUR },
	];
}
function admitMemory(h: IdentityHost, charges: readonly Charge[]): Result<never> | null {
	const v = h.windows.charge(charges, h.now().getTime());
	return v.ok ? null : refuse('rateLimited', 'Too many attempts. Try again later.', v.retryAfter);
}
const retryAfter = (h: IdentityHost) => Math.ceil((HOUR - (h.now().getTime() % HOUR)) / 1000);
const codeMac = (h: IdentityHost, email: string, code: string) =>
	createHmac('sha256', h.keys.session).update(`${addressOf(email)}\u0000${code}`).digest('hex');
/** Six digits from the host's CSPRNG (38a(d)), unbiased by rejection. */
function sixDigits(): string {
	for (;;) {
		const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
		if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, '0');
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

/**
 * Rule 38a(a–c): persists the challenge (replacing any earlier one) and only then hands the code to the mail port,
 * whether or not the address is a member. A mail refusal is returned; a fresh `sendCode` is allowed at once.
 */
export async function sendCode(h: IdentityHost, email: string, ip: string): Promise<Result<null>> {
	const charges = preSignIn(h, 'session.sendCode', email, ip);
	const limited = admitMemory(h, charges);
	if (limited) return limited;
	const code = h.devSink === true ? '123456' : sixDigits();
	const now = h.now();
	const s = stmt();
	const rate = ratePiece(charges, now.getTime(), s.p);
	const saved = await h.db.write({ params: s.params, text: `WITH ${rate.cte},
ch AS (INSERT INTO sys_challenge (address_mac, code_mac, attempts, expires_at)
	SELECT ${s.p(macKey(h.keys.ipMac, addressOf(email)))}, ${s.p(codeMac(h, email, code))}, 0, ${s.p(new Date(now.getTime() + CODE_MS).toISOString())}::timestamptz
	WHERE ${rate.admitted}
	ON CONFLICT (address_mac) DO UPDATE SET code_mac = excluded.code_mac, attempts = 0, expires_at = excluded.expires_at RETURNING 1)
SELECT count(*)::int AS saved FROM ch` });
	if (saved.rows[0]!.saved !== 1) return refuse('rateLimited', 'Too many attempts. Try again later.', retryAfter(h));
	const sent = await callPort('email', h.mail, LIMITS.callMs.other, (m, signal) =>
		m.send('email', { to: email, subject: 'Your sign-in code', text: `Your sign-in code is ${code}. It expires in 10 minutes.`, html: codeEmail(code) }, signal));
	return 'kind' in sent ? refuse(sent.kind === 'unavailable' ? 'unavailable' : sent.kind === 'timeout' ? 'timeout' : 'upstream', 'The code could not be sent.') : ok(null);
}

export type Session = { token: string; user: string; expiresAt: string };
export type Invitation = { id: string; email: string; team: string | null; assignments: { policy: string; scope?: Json }[]; external: boolean; party: Json };

// ── history (§5.11.1, rule 17): `sys_user`, `sys_team`, `sys_assignment` and `sys_invitation` keep `bolt_history` ──
/** The RETURNING of a CTE that writes a historied identity table: its id and both images. */
export const IMAGES = `RETURNING coalesce(new.id, old.id) AS id, CASE WHEN old.id IS NULL THEN NULL ELSE to_jsonb(old) END AS o,
	CASE WHEN new.id IS NULL THEN NULL ELSE to_jsonb(new) END AS n`;
const UUID = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
/**
 * The piece that appends one revision per row `cte` (returning `IMAGES`) wrote, in the same statement: the full row on
 * create, the changed fields on update, nothing on delete. ponytail: `bolt_history.record` is a uuid, so a row whose
 * id is not one (a hand-seeded `'u1'`) keeps no history.
 */
export function historyOf(s: ReturnType<typeof stmt>, table: 'sys_user' | 'sys_team' | 'sys_assignment' | 'sys_invitation', cte: string, at: Date, actor: string | null,
	cause: 'direct' | 'erased' = 'direct'): string {
	return `${cte}_h AS (INSERT INTO bolt_history (collection, record, revision, at, actor, op, cause, changes)
	SELECT ${s.p(table)}, x.id::uuid, coalesce((x.n->>'revision')::int, (x.o->>'revision')::int + 1), ${s.p(at.toISOString())}::timestamptz, ${s.p(actor)},
		CASE WHEN x.o IS NULL THEN 'create' WHEN x.n IS NULL THEN 'delete' ELSE 'update' END, ${s.p(cause)},
		CASE WHEN x.o IS NULL THEN x.n WHEN x.n IS NULL THEN '{}'::jsonb ELSE (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(x.n) AS e(k, v)
			WHERE k <> 'revision' AND x.o -> k IS DISTINCT FROM v) END
	FROM ${cte} x WHERE x.id ~* ${UUID})`;
}
/** The actor a history row names: `member:<id>` (as the write area's `actorRef`), or the host. */
export const by = (auth: Authority | null): string => auth !== null && auth.actor.kind === 'member' ? `member:${auth.actor.id}` : 'host';

export const MEMBERSHIP = 'bolt.membership';
/**
 * §5.11.3: the piece that queues one `bolt.membership` run per `sys_user` row `cte` wrote (its `IMAGES`) where `gate`
 * holds, or nothing when the host binds no membership port. An erased member projects no address and no team (38e(e)).
 */
export function projection(h: IdentityHost, s: ReturnType<typeof stmt>, cte: string, gate = 'true', erased = false): string {
	if (h.membership === undefined) return '';
	const input = erased ? `jsonb_build_object('user', x.id, 'email', NULL, 'team', NULL, 'state', 'erased')`
		: `jsonb_build_object('user', x.id, 'email', x.n->'email', 'team', x.n->'team', 'state', CASE WHEN (x.n->>'active')::boolean THEN 'active' ELSE 'inactive' END)`;
	return `,\n${cte}_m AS (INSERT INTO sys_run (id, automation, input, due_at, cause, depth)
	SELECT gen_random_uuid()::text, ${s.p(MEMBERSHIP)}, ${input}, ${s.p(h.now().toISOString())}::timestamptz, 'platform', 0 FROM ${cte} x WHERE ${gate})`;
}
/** After a verb whose statement may have queued `bolt.membership`: wake the queue now. */
export const announceMembership = (h: IdentityHost) => h.membership?.announce(h.now().toISOString());

/** A JSON value as a `::jsonb` parameter; SQL NULL for none. */
export const jsonb = (v: Json | undefined): Json => v === null || v === undefined ? null : JSON.stringify(v);

/**
 * The CTEs that accept an invitation for `user`: the stamp (`accepted`, only while the invitation is open and `gate`
 * holds), the member (`member`: an update of an existing member, or the row `born` inserted in this statement, since a
 * CTE cannot see another's writes), and its assignments.
 */
export function acceptPieces(s: ReturnType<typeof stmt>, inv: Invitation, user: string, now: Date, gate: string, born: boolean): string {
	const rows = inv.assignments.map((a) => `(${s.p(newId())}, 'sys_user', ${s.p(user)}, ${s.p(a.policy)}, ${s.p(jsonb(a.scope))}::jsonb)`);
	const actor = `member:${user}`;
	const member = born ? `member AS (SELECT id FROM born WHERE EXISTS (SELECT 1 FROM accepted))`
		: `member AS (UPDATE sys_user SET team = coalesce(${s.p(inv.team)}, team), kind = ${s.p(inv.external ? 'external' : 'staff')},
	party = ${s.p(jsonb(inv.party))}::jsonb, revision = revision + 1 WHERE id = ${s.p(user)} AND EXISTS (SELECT 1 FROM accepted) ${IMAGES}),
${historyOf(s, 'sys_user', 'member', now, actor)}`;
	return `accepted AS (UPDATE sys_invitation SET accepted_at = ${s.p(now.toISOString())}::timestamptz, revision = revision + 1
	WHERE ${openInvitation(s, inv.id, now)} AND ${gate} ${IMAGES}),
${historyOf(s, 'sys_invitation', 'accepted', now, actor)},
${member},
grants AS (${rows.length === 0 ? `SELECT NULL::text AS id, NULL::jsonb AS o, NULL::jsonb AS n WHERE false` : `INSERT INTO sys_assignment (id, principal_type, principal, policy, scope)
	SELECT * FROM (VALUES ${rows.join(', ')}) v WHERE EXISTS (SELECT 1 FROM member) ${IMAGES}`}),
${historyOf(s, 'sys_assignment', 'grants', now, actor)}`;
}
export const openInvitation = (s: ReturnType<typeof stmt>, id: string, now: Date) =>
	`id = ${s.p(id)} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${s.p(now.toISOString())}::timestamptz`;
const sessionValues = (s: ReturnType<typeof stmt>, now: Date, via: string, hash: string) =>
	`${s.p(newId())}, ${s.p(hash)}, ${s.p(via)}, ${s.p(now.toISOString())}::timestamptz, ${s.p(new Date(now.getTime() + SESSION_MS).toISOString())}::timestamptz, ${s.p(now.toISOString())}::timestamptz`;
export const SESSION_COLUMNS = `(id, "user", token_hash, via, created_at, expires_at, refreshed_at)`;

/**
 * Rule 38a(b): 3 attempts per code, compared in constant time, single use. Success mints a session for the member, or,
 * for an address with an open invitation and no member yet, creates the member and accepts it in the same statement.
 */
export async function verifyCode(h: IdentityHost, email: string, code: string, ip: string): Promise<Result<Session>> {
	const charges = preSignIn(h, 'session.verifyCode', email, ip);
	const limited = admitMemory(h, charges);
	if (limited) return limited;
	const now = h.now(), address = macKey(h.keys.ipMac, addressOf(email));
	const [challenges, users, invitations] = await h.db.read([
		{ text: 'SELECT code_mac, attempts, expires_at FROM sys_challenge WHERE address_mac = $1', params: [address] },
		{ text: 'SELECT id, active FROM sys_user WHERE lower(email) = $1', params: [addressOf(email)] },
		{ text: `SELECT id, email, team, assignments, external, party FROM sys_invitation WHERE lower(email) = $1 AND accepted_at IS NULL
			AND revoked_at IS NULL AND expires_at > $2::timestamptz ORDER BY expires_at DESC LIMIT 1`, params: [addressOf(email), now.toISOString()] },
	]);
	const ch = challenges!.rows[0] as { code_mac: string; attempts: number; expires_at: string } | undefined;
	if (ch === undefined || Date.parse(ch.expires_at) <= now.getTime()) return refuse('invalidCode', 'The code is wrong or has expired.');
	const s = stmt();
	const rate = ratePiece(charges, now.getTime(), s.p);
	const given = Buffer.from(codeMac(h, email, /^\d{6}$/.test(code) ? code : 'x'), 'hex');
	if (!timingSafeEqual(given, Buffer.from(ch.code_mac, 'hex'))) {
		const a = s.p(address), n = s.p(ch.attempts);
		await h.db.write({ params: s.params, text: `WITH ${rate.cte},
bump AS (UPDATE sys_challenge SET attempts = attempts + 1 WHERE address_mac = ${a} AND attempts = ${n} AND attempts + 1 < ${ATTEMPTS} RETURNING 1),
gone AS (DELETE FROM sys_challenge WHERE address_mac = ${a} AND attempts = ${n} AND attempts + 1 >= ${ATTEMPTS} RETURNING 1)
SELECT 1` });
		return refuse('invalidCode', 'The code is wrong or has expired.');
	}
	const user = users!.rows[0] as { id: string; active: boolean } | undefined;
	const inv = invitations!.rows[0] as Invitation | undefined;
	if (user !== undefined && !user.active) return refuse('notMember', 'This member is deactivated.');
	if (user === undefined && inv === undefined) return refuse('notMember', 'This address has no invitation to this workspace.');
	const token = randomToken(), userId = user?.id ?? newId();
	const used = `used AS (DELETE FROM sys_challenge WHERE address_mac = ${s.p(address)} AND attempts = ${s.p(ch.attempts)} AND ${rate.admitted} RETURNING 1)`;
	const pieces = [rate.cte, used];
	if (user === undefined) {
		const i = inv!;
		pieces.push(`born AS (INSERT INTO sys_user (id, email, name, kind, team, party)
	SELECT ${s.p(userId)}, ${s.p(email.trim())}, ${s.p(email.trim().split('@')[0]!)}, ${s.p(i.external ? 'external' : 'staff')}, ${s.p(i.team)}, ${s.p(jsonb(i.party))}::jsonb
	WHERE EXISTS (SELECT 1 FROM used) AND EXISTS (SELECT 1 FROM sys_invitation WHERE ${openInvitation(s, i.id, now)}) ${IMAGES}),
${historyOf(s, 'sys_user', 'born', now, `member:${userId}`)}`);
		pieces.push(acceptPieces(s, i, userId, now, 'EXISTS (SELECT 1 FROM born)', true));
	}
	const via = user === undefined ? 'invitation' : 'code';
	const born = user === undefined;
	// §5.11.3: a member born by accepting an invitation is projected, in this statement
	const project = born ? projection(h, s, 'born', 'EXISTS (SELECT 1 FROM accepted)') : '';
	const out = await h.db.write({ params: s.params, text: `WITH ${pieces.join(',\n')}${project},
sess AS (INSERT INTO sys_session ${SESSION_COLUMNS} SELECT v.id, ${s.p(userId)}, v.h, v.via, v.c, v.e, v.r
	FROM (VALUES (${sessionValues(s, now, via, sha256(token))})) v(id, h, via, c, e, r)
	WHERE EXISTS (SELECT 1 FROM ${born ? 'member' : 'used'}) RETURNING expires_at)
SELECT (SELECT expires_at FROM sess) AS expires_at` }, lock(born));
	const expires = out.rows[0]?.expires_at;
	if (expires === null || expires === undefined) return refuse('invalidCode', 'The code is wrong or has expired.');
	if (project !== '') announceMembership(h);
	return ok({ token, user: userId, expiresAt: new Date(String(expires)).toISOString() });
}
const lock = (born: boolean): Lock | undefined => born ? { advisory: ['sys_user.email'] } : undefined;

type Authenticated = { user: string; session: string; impersonatedBy: string | null };
/**
 * L-COL-034: the sessions this identity host (one per engine generation, so a flip, reset or restore starts empty) has
 * authenticated, for 30 s at most and never past their expiry, one read in flight per token. A miss or a failure is
 * never kept (fail closed); `forget` drops a signed-out token. Membership and activity are not memoised: the caller's
 * authority re-reads `sys_user` on every request, so a deactivated member is refused at once.
 */
const MEMO_MS = 30_000, MEMO_MAX = 10_000;
const memos = new WeakMap<IdentityHost, Map<string, { at: Promise<Authenticated | null>; until: number }>>();
export const forget = (h: IdentityHost, token: string) => memos.get(h)?.delete(sha256(token));

/** The session a cookie token names, or `null`. Refreshes the lifetime at most once a day (§5.11.2). */
export function authenticate(h: IdentityHost, token: string): Promise<Authenticated | null> {
	let memo = memos.get(h);
	if (memo === undefined) memos.set(h, memo = new Map());
	const key = sha256(token), now = h.now().getTime(), held = memo.get(key);
	if (held !== undefined && held.until > now) return held.at;
	const found = lookup(h, key);
	// every caller, first or memoised, gets the same session shape; the expiry only bounds the memo
	const entry = { until: now + MEMO_MS, at: found.then((r) => r === null ? null : { user: r.user, session: r.session, impersonatedBy: r.impersonatedBy }) };
	memo.set(key, entry);
	if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
	found.then((r) => {
		if (r === null) { if (memo.get(key) === entry) memo.delete(key); }
		else entry.until = Math.min(entry.until, r.expiresAt);
	}, () => { if (memo.get(key) === entry) memo.delete(key); });
	return entry.at;
}
async function lookup(h: IdentityHost, hash: string): Promise<(Authenticated & { expiresAt: number }) | null> {
	const now = h.now();
	const [rows] = await h.db.read([{ text: `SELECT s.id, s."user", s.impersonated_by, s.refreshed_at, s.expires_at FROM sys_session s JOIN sys_user u ON u.id = s."user"
		WHERE s.token_hash = $1 AND s.expires_at > $2::timestamptz AND u.active`, params: [hash, now.toISOString()] }]);
	const r = rows!.rows[0] as { id: string; user: string; impersonated_by: string | null; refreshed_at: string; expires_at: string } | undefined;
	if (r === undefined) return null;
	let expiresAt = Date.parse(String(r.expires_at));
	if (now.getTime() - Date.parse(r.refreshed_at) >= DAY) {
		expiresAt = now.getTime() + SESSION_MS;
		await h.db.write({ text: `UPDATE sys_session SET refreshed_at = $2::timestamptz, expires_at = $3::timestamptz WHERE id = $1`,
			params: [r.id, now.toISOString(), new Date(expiresAt).toISOString()] });
	}
	return { user: r.user, session: r.id, impersonatedBy: r.impersonated_by, expiresAt };
}

/** `session.mint { user }` (§5.11.3): host authority only; refused unless the user exists and is active. */
export async function mint(h: IdentityHost, user: string): Promise<Result<Session>> {
	const now = h.now(), token = randomToken(), s = stmt();
	const out = await h.db.write({ params: s.params, text: `INSERT INTO sys_session ${SESSION_COLUMNS}
SELECT v.id, u.id, v.h, v.via, v.c, v.e, v.r FROM sys_user u, (VALUES (${sessionValues(s, now, 'host', sha256(token))})) v(id, h, via, c, e, r)
WHERE u.id = ${s.p(user)} AND u.active RETURNING expires_at` });
	const e = out.rows[0]?.expires_at;
	return e === undefined ? refuse('notFound', 'No active member.') : ok({ token, user, expiresAt: new Date(String(e)).toISOString() });
}

/**
 * `founder.bootstrap { email, name? }` (§5.11.3): host only; creates the first admin and a session for the proven
 * address; idempotent per address (a second call mints a session for the same member); refused once another admin exists.
 */
export async function founderBootstrap(h: IdentityHost, email: string, name?: string): Promise<Result<Session>> {
	const now = h.now(), token = randomToken(), s = stmt(), id = newId();
	const e = s.p(addressOf(email));
	try {
		const out = await h.db.write({ params: s.params, text: `WITH existing AS (SELECT id FROM sys_user WHERE lower(email) = ${e} AND admin AND active),
ins AS (INSERT INTO sys_user (id, email, name, kind, admin) SELECT ${s.p(id)}, ${s.p(email.trim())}, ${s.p(name ?? email.trim().split('@')[0]!)}, 'staff', true
	WHERE NOT EXISTS (SELECT 1 FROM sys_user WHERE admin) ${IMAGES}),
${historyOf(s, 'sys_user', 'ins', now, 'host')},
u AS (SELECT id FROM existing UNION ALL SELECT id FROM ins),
sess AS (INSERT INTO sys_session ${SESSION_COLUMNS} SELECT v.id, u.id, v.h, v.via, v.c, v.e, v.r
	FROM u, (VALUES (${sessionValues(s, now, 'host', sha256(token))})) v(id, h, via, c, e, r) RETURNING "user", expires_at)
SELECT "user", expires_at FROM sess` }, { advisory: ['sys_user.admins'] });
		const r = out.rows[0] as { user: string; expires_at: string } | undefined;
		return r === undefined ? refuse('forbidden', 'This workspace already has an administrator.')
			: ok({ token, user: r.user, expiresAt: new Date(r.expires_at).toISOString() });
	} catch (err) {
		if (err instanceof DbError && err.sqlstate === '23505') return refuse('forbidden', 'This address already belongs to a member.');
		throw err;
	}
}
