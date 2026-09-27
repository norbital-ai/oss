// The write area's SQL plumbing (A5): the `WITH` chain builder behind rule 20's one
// statement, the own-row predicate compiler of roll-up `where`s, and the SQLSTATE map (G3).
import type { Json } from '../../decl/values.ts';
import { BoltError, DbError, type Outcome, type Pred, type Sql, type TenantDb } from '../contracts.ts';
import { inline } from '../db/postgres.ts';
import type { ConstraintMeta } from '../schema/ddl.ts';
import { refusalOf } from '../schema/refusal.ts';
import { q, type FieldInfo } from '../../protocol/catalog.ts';

/** The idempotency gate's condition (rule 20): every data-modifying piece reads its rows through it. */
export const GATED = 'EXISTS (SELECT 1 FROM idem)';

/**
 * The one writer of `sys_notification` (L-BOLT-356): rows `{ id, to, title, body?, link?, once? }` inserted when `when`
 * holds, `once` deduping. Every notice (a write's, an approval event's, `ctx.notify`'s) is this piece. An `inbox` notice
 * fans out here into one row per active staff member it names (L-BOLT-354: `member`, and that member's own `read_at`):
 * `{ user }`, `{ team }` (the member's own team, by name), `{ policy }` (held through the team's `+team.ts` — `teams` is
 * the manifest's — or an assignment to the member or their team). A notice for another channel stays one row, its
 * descriptor expanded by `notifications.deliver`. An inbox notice naming no member writes nothing, and stays in the piece
 * `<name>_to` with a null `member` so a caller can report it (final-automations rule 21: reported, never refused).
 * The inserted rows reach the live lane through `noticeCaptures` (the inbox is a live read).
 */
export const noticeInsert = (c: Chain, name: string, rows: Json, now: string, teams: { readonly [team: string]: readonly string[] },
	when: string = GATED): string =>
	(c.notices.push(name), c.cte(`${name}_to`, `SELECT CASE WHEN mem.id IS NULL THEN v.id ELSE v.id || ':' || mem.id END AS id, v.id AS notice, v."to", mem.id AS member,
		v.title, v.body, v.link, CASE WHEN mem.id IS NULL THEN v.once ELSE v.once || ':' || mem.id END AS once
	FROM jsonb_to_recordset(${c.p(rows)}::jsonb) AS v(id text, "to" jsonb, title text, body text, link jsonb, once text)
	LEFT JOIN LATERAL (SELECT u.id FROM sys_user u LEFT JOIN sys_team t ON t.id = u.team
		WHERE coalesce(v."to"->>'channel', 'inbox') = 'inbox' AND u.active AND u.kind = 'staff' AND EXISTS (SELECT 1 FROM jsonb_array_elements(
			CASE WHEN v."to" ? 'recipients' THEN v."to"->'recipients' WHEN jsonb_typeof(v."to") = 'array' THEN v."to" ELSE jsonb_build_array(v."to") END) r
			WHERE r->>'user' = u.id OR lower(r->>'team') = lower(t.name)
				OR EXISTS (SELECT 1 FROM jsonb_each(${c.p(teams as unknown as Json)}::jsonb) tp WHERE lower(tp.key) = lower(t.name) AND tp.value ? (r->>'policy'))
				OR EXISTS (SELECT 1 FROM sys_assignment s WHERE s.policy = r->>'policy'
					AND ((s.principal_type = 'sys_user' AND s.principal = u.id) OR (s.principal_type = 'sys_team' AND s.principal = u.team))))) mem ON true`),
	c.cte(name, `INSERT INTO sys_notification (id, recipient, member, title, body, link, once, at)
	SELECT id, "to", member, title, body, link, once, ${c.p(now)}::timestamptz FROM ${name}_to
	WHERE (coalesce("to"->>'channel', 'inbox') <> 'inbox' OR member IS NOT NULL) AND (${when}) ON CONFLICT (once) DO NOTHING
	RETURNING id, member, to_jsonb(sys_notification) AS image`));
/** The chain's inserted inbox notices as `Captured` rows (JSON), for the statement's select to hand to the live lane. */
export const noticeCaptures = (c: Chain): string => c.notices.length === 0 ? `'[]'::jsonb`
	: `(SELECT coalesce(jsonb_agg(jsonb_build_object('collection', 'sys_notification', 'id', x.id, 'op', 'create', 'revision', 0, 'old', NULL, 'new', x.image,
		'cause', 'direct')), '[]'::jsonb) FROM (${c.notices.map((n) => `SELECT r.id, r.image FROM ${n} r WHERE r.member IS NOT NULL`).join(' UNION ALL ')}) x)`;

/**
 * One `WITH` chain. Pieces keep definition order (a non-recursive `WITH` refers only backwards); every data-modifying
 * piece runs whether or not it is referenced, and every assert is referenced by the final select so it always runs.
 */
export class Chain {
	readonly params: Json[] = [];
	/** The `noticeInsert` pieces in this chain (`noticeCaptures`). */
	readonly notices: string[] = [];
	private readonly ctes: string[] = [];
	private readonly asserts: string[] = [];
	/** A positional parameter; objects and arrays travel as JSON text (`$n::jsonb`). */
	p(v: Json): string {
		this.params.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
		return `$${this.params.length}`;
	}
	cte(name: string, sql: string): string {
		this.ctes.push(`${name} AS (${sql})`);
		return name;
	}
	/** Fails the whole statement with `code` unless `ok`; vacuous when the gate is closed (a replay writes nothing). */
	assert(ok: string, code: string, detail: Json = null): string {
		const name = `a${this.asserts.length}`;
		this.ctes.push(`${name} AS MATERIALIZED (SELECT bolt_assert(NOT ${GATED} OR (${ok}), ${this.p(code)}, ${this.p(detail)}))`);
		this.asserts.push(name);
		return name;
	}
	sql(select: string): { text: string; params: readonly Json[] } {
		const guards = this.asserts.map((a) => `(SELECT count(*) FROM ${a})`).join(' + ') || '0';
		return { text: `WITH ${this.ctes.join(',\n')}\nSELECT ${select}, ${guards} AS guarded`, params: this.params };
	}
}

/** The gate piece and the outcome piece (rule 20); `expr` builds the new outcome from the other pieces' RETURNING. */
export function gate(c: Chain, key: string, digest: string, issuedAt: string): void {
	c.cte('idem', `INSERT INTO bolt_idem (key, digest, issued_at) VALUES (${c.p(key)}, ${c.p(digest)}, ${c.p(issuedAt)}::timestamptz)
	ON CONFLICT (key) DO UPDATE SET digest = excluded.digest, issued_at = excluded.issued_at
	WHERE bolt_idem.issued_at < excluded.issued_at - interval '24 hours' RETURNING key`);
}
/** The statement's answer: the new outcome, or the stored one when the digest matches, else `keyReuse` (rule 31). */
export function answer(c: Chain, key: string, digest: string, expr: string): string {
	c.cte('out', `INSERT INTO bolt_idem_outcome (key, outcome) SELECT key, ${expr} FROM idem
	ON CONFLICT (key) DO UPDATE SET outcome = excluded.outcome RETURNING outcome`);
	return `coalesce((SELECT outcome FROM out), ${storedOutcome(c.p(key), c.p(digest))}) AS outcome`;
}
export const KEY_REUSE: Outcome = { kind: 'refused', code: 'keyReuse', message: 'This key was used for a different request.' };
export const storedOutcome = (key: string, digest: string): string => `(SELECT CASE WHEN i.digest = ${digest} THEN o.outcome
	ELSE '${JSON.stringify(KEY_REUSE)}'::jsonb END FROM bolt_idem i JOIN bolt_idem_outcome o USING (key) WHERE i.key = ${key})`;

/** A rate increment gated on the idempotency gate, re-checked against its limit (rule 38 persistence). */
export function rate(c: Chain, charges: readonly { rule: string; bucket: string; limit: number; windowStart: string }[]): void {
	if (charges.length === 0) return;
	c.cte('rate', `INSERT INTO bolt_rate (rule, bucket, window_start, n)
	SELECT v.rule, v.bucket, v.window_start, 1 FROM jsonb_to_recordset(${c.p(charges.map((x) => ({ rule: x.rule, bucket: x.bucket, window_start: x.windowStart })))}::jsonb)
		AS v(rule text, bucket text, window_start timestamptz) WHERE ${GATED}
	ON CONFLICT (rule, bucket, window_start) DO UPDATE SET n = bolt_rate.n + 1 RETURNING rule, bucket, n`);
	const limits = c.p(charges.map((x) => ({ rule: x.rule, bucket: x.bucket, lim: x.limit })));
	c.assert(`NOT EXISTS (SELECT 1 FROM rate JOIN jsonb_to_recordset(${limits}::jsonb) AS l(rule text, bucket text, lim int) USING (rule, bucket) WHERE rate.n > l.lim)`, 'rateLimited');
}

/**
 * An own-row `Pred` over a row expression (roll-up `where`, a `StaticWhere`: literals and same-row fields only).
 * ponytail: the query area (A4) owns Pred → SQL; this covers the static own-row subset until it lands.
 */
export function ownPredSql(p: Pred, row: string, c: Chain): string {
	const col = (f: string) => `(${row}).${q(f)}`;
	const val = (a: unknown): string => {
		const o = a as { lit?: Json; field?: string };
		if (o.field !== undefined) return col(o.field);
		if ('lit' in o) return c.p(untag(o.lit ?? null));
		throw new BoltError('invalidWhere', 'derive', 'a roll-up where takes literals and same-row fields only');
	};
	const OPS = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
	switch (p.t) {
		case 'const': return p.value ? 'true' : 'false';
		case 'and': case 'or': return p.of.length === 0 ? String(p.t === 'and') : `(${p.of.map((x) => ownPredSql(x, row, c)).join(` ${p.t.toUpperCase()} `)})`;
		case 'not': return `(NOT ${ownPredSql(p.of, row, c)})`;
		case 'null': return `(${col(p.field)} IS ${p.is ? '' : 'NOT '}NULL)`;
		case 'cmp': return `(${col(p.field)} ${OPS[p.op]} ${val(p.arg)})`;
		case 'in': {
			if (!Array.isArray(p.args)) throw new BoltError('invalidWhere', 'derive', 'a roll-up where takes literal lists only');
			return `(${col(p.field)}::text ${p.negated ? 'NOT ' : ''}IN (SELECT jsonb_array_elements_text(${c.p(p.args.map((x) => untag(x)))}::jsonb)))`;
		}
		case 'like': return `(${col(p.field)} LIKE ${c.p(p.pattern)})`;
		default: throw new BoltError('invalidWhere', 'derive', `a roll-up where cannot use '${p.t}'`);
	}
}

/**
 * Tagged wire values (`$dec`, `$t`, `$d`) → their text, which Postgres casts per column. With the column's field, a
 * period becomes its range literal (X-11): a date period `{ from, to }` is inclusive `[from,to]` (Postgres stores
 * `[from,to+1)`), an instant period `{ start, end }` closed-open; a null end is open; a point `(lng,lat)`.
 */
export function untag(v: Json, f?: Pick<FieldInfo, 'kind' | 'periodOf'>): Json {
	if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
		const o = v as { readonly [k: string]: Json }, keys = Object.keys(o);
		if (keys.length === 1 && (keys[0] === '$dec' || keys[0] === '$t' || keys[0] === '$d')) return o[keys[0]]!;
		// a point `{ lat, lng }` is a Postgres `point` literal (x = lng, y = lat)
		if (f?.kind === 'point') return `(${String(o['lng'])},${String(o['lat'])})`;
		if (f?.kind === 'period') {
			const [lo, hi] = f.periodOf === 'date' ? [o['from'], o['to']] : [o['start'], o['end']];
			return `[${String(untag(lo ?? null))},${hi == null ? '' : String(untag(hi))}${f.periodOf === 'date' ? ']' : ')'}`;
		}
	}
	return v;
}

/**
 * One field's stored columns (`untag`ged): an exclusive arc's `RecordRef` spreads over its arm columns `<fk>__<arm>`,
 * the named arm holding the id and every other arm null (the arc CHECK allows at most one); `null` clears them all.
 */
export function cells(k: string, v: Json, f?: Pick<FieldInfo, 'kind' | 'periodOf' | 'arms' | 'column'>): [string, Json][] {
	if (f?.arms === undefined) return [[k, untag(v, f)]];
	const ref = v as { collection?: Json; id?: Json } | null;
	return f.arms.map((arm) => [`${f.column}__${arm}`, ref?.collection === arm ? ref.id ?? null : null]);
}

// ── SQLSTATE → outcome (rule 20 "Postgres-decided outcomes"): the schema area's map, plus `bolt_assert`'s codes ──
export type Decided = { outcome: Outcome; record: boolean; replay: boolean };
export function decided(e: unknown, constraints: ReadonlyMap<string, ConstraintMeta>): Decided {
	if (!(e instanceof DbError)) throw e;
	if (e.sqlstate === 'BA001') {
		// `bolt_assert` raises `<code> <detail>`: the DbError contract carries the message, not Postgres's DETAIL
		const space = e.message.indexOf(' ');
		const [code, detail] = space < 0 ? [e.message, ''] : [e.message.slice(0, space), e.message.slice(space + 1)];
		if (code === 'conflict') return { outcome: { kind: 'conflict', records: conflictRecords(detail) }, record: true, replay: false };
		// rule 26: a transform read moved between the read and the commit: replayed once, then `conflict`
		if (code === 'fingerprint') return { outcome: { kind: 'conflict', records: [] }, record: true, replay: true };
		// a recorded `rateLimited` would answer the client's resend after `retryAfter` for 24 h (rule 20)
		if (code === 'rateLimited') return { outcome: { kind: 'refused', code, message: 'Too many requests; try again later.' }, record: false, replay: false };
		return { outcome: { kind: 'refused', code: 'locked', message: 'The parent record is locked in its current state.' }, record: true, replay: false };
	}
	const r = refusalOf(e, constraints);
	if (r instanceof BoltError) throw r;
	return r === 'conflict' ? { outcome: { kind: 'conflict', records: [] }, record: true, replay: true } : { outcome: r, record: true, replay: false };
}
const conflictRecords = (detail: string): { collection: string; id: string; fields: string[] }[] => {
	try {
		const d = JSON.parse(detail) as { collection: string; ids: string[] };
		return d.ids.map((id) => ({ collection: d.collection, id, fields: [] }));
	} catch { return []; }
};

// ── hashing and ids (rules 24, 31) ──
/** Canonical JSON: keys sorted at every depth, so a digest does not depend on key order. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
	x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : 1)) : x);
export async function sha256(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
export const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
/**
 * Ids minted inside an invocation derive from `(invocationId, n)` (rule 24): a uuidv7 whose time is the invocation's
 * `now` and whose random bits are the invocation's hash with `n` folded in, so a replay mints the same ids.
 */
export async function minter(invocationId: string, now: string): Promise<() => string> {
	const seed = await sha256(`mint:${invocationId}`);
	const ms = Date.parse(now);
	let n = 0;
	return () => {
		const b = seed.slice(0, 16);
		for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
		const k = n++;
		b[12]! ^= (k >>> 24) & 0xff; b[13]! ^= (k >>> 16) & 0xff; b[14]! ^= (k >>> 8) & 0xff; b[15]! ^= k & 0xff;
		b[6] = (b[6]! & 0x0f) | 0x70; b[8] = (b[8]! & 0x3f) | 0x80;
		const h = hex(b);
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
	};
}

// ── rule 26: optimistic transform reads ──
/** A read statement and the digest of its rows as they were read. */
export type Fingerprint = { sql: Sql; digest: string };
const digestOf = (text: string): string => `(SELECT md5(coalesce(string_agg(to_jsonb(s)::text, E'\\n'), '')) FROM (${text}) s)`;
/**
 * Wraps a `TenantDb` so every read statement is fingerprinted in the same round trip: its digest statement rides with
 * it in the same read snapshot. The commit re-computes each digest under its table lock and asserts it.
 */
export function fingerprinting(db: TenantDb): { db: TenantDb; fingerprints(): readonly Fingerprint[] } {
	const taken: Fingerprint[] = [];
	return {
		fingerprints: () => taken,
		db: { ...db, async read(statements, signal) {
			const res = await db.read([...statements, ...statements.map((s) => ({ text: `SELECT ${digestOf(s.text)} AS d`, params: s.params }))], signal);
			statements.forEach((sql, i) => taken.push({ sql, digest: String(res[statements.length + i]!.rows[0]!['d']) }));
			return res.slice(0, statements.length);
		} },
	};
}
/** One assert per fingerprint: the rows read then are the rows now (rule 26). */
export function fingerprintAsserts(c: Chain, fps: readonly Fingerprint[]): void {
	for (const f of fps) c.assert(`${digestOf(inline(f.sql))} = ${c.p(f.digest)}`, 'fingerprint');
}
