// The write area's SQL plumbing (A5): the `WITH` chain builder behind rule 20's one
// statement, the own-row predicate compiler of roll-up `where`s, and the SQLSTATE map (G3).
import type { Json } from '../../decl/values.ts';
import type { TeamEntries } from '../../decl/access/team.ts';
import { teamEntries } from '../manifest.ts';
import { createHash } from 'node:crypto';
import { Effect, Predicate, Result, Schema } from 'effect';
import type { Outcome, RowData, Sql } from '../contracts.ts';

import type { Arg, Pred } from '../../protocol/ir-types.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { DbError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { inline } from '../db/postgres.ts';
import { composable } from '../query/sql.ts';
import type { ConstraintMeta } from '../schema/ddl.ts';
import { refusalOf } from '../schema/refusal.ts';
import { q, type FieldInfo } from '../../protocol/catalog.ts';

/** The idempotency gate's condition (rule 20): every data-modifying piece reads its rows through it. */
export const GATED = 'EXISTS (SELECT 1 FROM idem)';

/** One transactional in-app notice per active staff recipient, plus an optional external delivery descriptor. */
export const noticeInsert = (
	c: Chain,
	name: string,
	rows: Json,
	now: string,
	when: string = GATED,
	teams: TeamEntries = {},
	signup: readonly string[] = []
): string => {
	const policies = c.p(
		Object.fromEntries(
			Object.entries(teamEntries(teams)).map(([handle, team]) => [handle, team.policies])
		)
	);
	return (
		c.notices.push(name),
		c.cte(
			`${name}_source`,
			`SELECT * FROM jsonb_to_recordset(${c.p(rows)}::jsonb)
		AS v(id text, "to" jsonb, title text, body text, link jsonb, once text)`
		),
		c.cte(
			`${name}_to`,
			`SELECT v.id || ':' || mem.id AS id, v.id AS notice,
		jsonb_build_object('channel', 'inbox', 'recipients', CASE WHEN v."to" ? 'recipients' THEN v."to"->'recipients' WHEN jsonb_typeof(v."to") = 'array' THEN v."to" ELSE jsonb_build_array(v."to") END) AS "to", mem.id AS member,
		v.title, v.body, v.link, v.once || ':' || mem.id AS once
	FROM ${name}_source v LEFT JOIN LATERAL (SELECT u.id FROM sys_user u
		WHERE u.active AND u.kind = 'staff' AND EXISTS (SELECT 1 FROM jsonb_array_elements(
			CASE WHEN v."to" ? 'recipients' THEN v."to"->'recipients' WHEN jsonb_typeof(v."to") = 'array' THEN v."to" ELSE jsonb_build_array(v."to") END) r
			WHERE r->>'user' = u.id OR (r->>'team' = u.team AND ${policies}::jsonb ? u.team)
				OR EXISTS (SELECT 1 FROM jsonb_each(${policies}::jsonb) s
					WHERE s.key = u.team AND s.value ? (r->>'policy'))
				OR (u.signup AND ${c.p(signup)}::jsonb ? (r->>'policy')))) mem ON true
	UNION ALL SELECT v.id, v.id, v."to", NULL::text, v.title, v.body, v.link, v.once FROM ${name}_source v
	WHERE coalesce(v."to"->>'channel', 'inbox') <> 'inbox'`
		),
		c.cte(
			name,
			`INSERT INTO sys_notification (id, recipient, member, title, body, link, once, at)
	SELECT id, "to", member, title, body, link, once, ${c.p(now)}::timestamptz FROM ${name}_to
	WHERE (member IS NOT NULL OR coalesce("to"->>'channel', 'inbox') <> 'inbox') AND (${when}) ON CONFLICT (once) DO NOTHING
	RETURNING id, member, to_jsonb(sys_notification) AS image`
		)
	);
};
/** The chain's inserted inbox notices as `Captured` rows (JSON), for the statement's select to hand to the live lane. */
export const noticeCaptures = (c: Chain): string =>
	c.notices.length === 0
		? `'[]'::jsonb`
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
		this.ctes.push(
			`${name} AS MATERIALIZED (SELECT bolt_assert(NOT ${GATED} OR (${ok}), ${this.p(code)}, ${this.p(detail)}))`
		);
		this.asserts.push(name);
		return name;
	}
	/** `assert` whose detail is computed in the statement (`detail` is SQL text). */
	assertWith(ok: string, code: string, detail: string): string {
		const name = `a${this.asserts.length}`;
		this.ctes.push(
			`${name} AS MATERIALIZED (SELECT bolt_assert(NOT ${GATED} OR (${ok}), ${this.p(code)}, ${detail}))`
		);
		this.asserts.push(name);
		return name;
	}
	sql(select: string): { text: string; params: readonly Json[] } {
		const guards = this.asserts.map((a) => `(SELECT count(*) FROM ${a})`).join(' + ') || '0';
		return {
			text: `WITH ${this.ctes.join(',\n')}\nSELECT ${select}, ${guards} AS guarded`,
			params: this.params
		};
	}
}

/** The gate piece and the outcome piece (rule 20); `expr` builds the new outcome from the other pieces' RETURNING. */
export function gate(c: Chain, key: string, digest: string, issuedAt: string): void {
	c.cte(
		'idem',
		`INSERT INTO bolt_idem (key, digest, issued_at) VALUES (${c.p(key)}, ${c.p(digest)}, ${c.p(issuedAt)}::timestamptz)
	ON CONFLICT (key) DO UPDATE SET digest = excluded.digest, issued_at = excluded.issued_at
	WHERE bolt_idem.issued_at < excluded.issued_at - interval '24 hours' RETURNING key`
	);
}
/** The statement's answer: the new outcome, or the stored one when the digest matches, else `keyReuse` (rule 31). */
export function answer(c: Chain, key: string, digest: string, expr: string): string {
	c.cte(
		'out',
		`INSERT INTO bolt_idem_outcome (key, outcome) SELECT key, ${expr} FROM idem
	ON CONFLICT (key) DO UPDATE SET outcome = excluded.outcome RETURNING outcome`
	);
	return `coalesce((SELECT outcome FROM out), ${storedOutcome(c.p(key), c.p(digest))}) AS outcome`;
}
export const KEY_REUSE: Outcome = {
	kind: 'refused',
	code: 'keyReuse',
	message: 'This key was used for a different request.'
};
export const storedOutcome = (
	key: string,
	digest: string
): string => `(SELECT CASE WHEN i.digest = ${digest} THEN o.outcome
	ELSE '${JSON.stringify(KEY_REUSE)}'::jsonb END FROM bolt_idem i JOIN bolt_idem_outcome o USING (key) WHERE i.key = ${key})`;

/** A rate increment gated on the idempotency gate, re-checked against its limit (rule 38 persistence). */
export function rate(
	c: Chain,
	charges: readonly { rule: string; bucket: string; limit: number; windowStart: string }[]
): void {
	if (charges.length === 0) return;
	c.cte(
		'rate',
		`INSERT INTO bolt_rate (rule, bucket, window_start, n)
	SELECT v.rule, v.bucket, v.window_start, 1 FROM jsonb_to_recordset(${c.p(charges.map((x) => ({ rule: x.rule, bucket: x.bucket, window_start: x.windowStart })))}::jsonb)
		AS v(rule text, bucket text, window_start timestamptz) WHERE ${GATED}
	ON CONFLICT (rule, bucket, window_start) DO UPDATE SET n = bolt_rate.n + 1 RETURNING rule, bucket, n`
	);
	const limits = c.p(charges.map((x) => ({ rule: x.rule, bucket: x.bucket, lim: x.limit })));
	c.assert(
		`NOT EXISTS (SELECT 1 FROM rate JOIN jsonb_to_recordset(${limits}::jsonb) AS l(rule text, bucket text, lim int) USING (rule, bucket) WHERE rate.n > l.lim)`,
		'rateLimited'
	);
}

/** Own-row predicates share the read IR; DDL requests two-valued, typed literal SQL. */
export function ownPredSql(
	p: Pred,
	row: string,
	c: Chain,
	twoValued = false,
	fields?: ReadonlyMap<string, FieldInfo>
): string {
	const ddl = fields !== undefined;
	const col = (field: string) => {
		const name = fields?.get(field)?.column ?? field;
		return row === '' ? q(name) : row.endsWith('.') ? `${row}${q(name)}` : `(${row}).${q(name)}`;
	};
	const literal = (value: Json, type?: string): string => {
		if (!ddl) return c.p(databaseValue(value));
		if (value === null) return 'null';
		if (typeof value === 'boolean') return String(value);
		return `'${String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll("'", "''")}'::${type ?? 'text'}`;
	};
	const val = (arg: Arg, field: string, type = fields?.get(field)?.pg): string => {
		if (arg._tag === 'Field') return col(arg.field);
		if (arg._tag === 'Lit') return literal(databaseValue(arg.value), type);
		throw BoltError.make(
			'invalidWhere',
			'derive',
			"a same-row where takes literals and the row's own fields only"
		);
	};
	const leaf = (sql: string) => (twoValued ? `coalesce(${sql}, false)` : ddl ? sql : `(${sql})`);
	const child = (pred: Pred) => ownPredSql(pred, row, c, twoValued, fields);
	const OPS = {
		eq: '=',
		ne: ddl ? 'is distinct from' : '<>',
		lt: '<',
		lte: '<=',
		gt: '>',
		gte: '>='
	} as const;
	switch (p.t) {
		case 'const':
			return String(p.value);
		case 'and':
		case 'or':
			return p.of.length === 0
				? String(p.t === 'and')
				: `(${p.of.map(child).join(` ${ddl ? p.t : p.t.toUpperCase()} `)})`;
		case 'not': {
			const body = child(p.of);
			return ddl
				? `(not ${p.of.t === 'and' || p.of.t === 'or' || p.of.t === 'not' ? body : `(${body})`})`
				: `(NOT ${body})`;
		}
		case 'null':
			return ddl
				? `${col(p.field)} is ${p.is ? '' : 'not '}null`
				: `(${col(p.field)} IS ${p.is ? '' : 'NOT '}NULL)`;
		case 'cmp': {
			const sql = `${col(p.field)} ${OPS[p.op]} ${val(p.arg, p.field)}`;
			return ddl && p.op === 'ne' ? sql : leaf(sql);
		}
		case 'in': {
			if (!Array.isArray(p.args))
				throw BoltError.make('invalidWhere', 'derive', 'a same-row where takes literal lists only');
			if (ddl) {
				const type = fields.get(p.field)?.pg ?? 'text';
				if (!twoValued)
					return `${col(p.field)}${p.negated ? ' not' : ''} in (${p.args.map((value) => literal(databaseValue(value), type)).join(', ')})`;
				const hit = leaf(
					`${col(p.field)} = any(array[${p.args.map((value) => literal(databaseValue(value), type)).join(', ')}]::${type}[])`
				);
				return p.negated ? `not ${hit}` : hit;
			}
			return leaf(
				`${col(p.field)}::text ${p.negated ? 'NOT ' : ''}IN (SELECT jsonb_array_elements_text(${c.p(p.args.map((value) => databaseValue(value)))}::jsonb))`
			);
		}
		case 'like':
			return leaf(
				`${col(p.field)} ${ddl ? 'like' : 'LIKE'} ${ddl ? `'${p.pattern.replaceAll("'", "''")}'` : c.p(p.pattern)}`
			);
		case 'list': {
			if (p.op === 'isEmpty')
				return leaf(`cardinality(${col(p.field)}) ${p.arg === true ? '= 0' : '> 0'}`);
			const values = Array.isArray(p.arg) ? p.arg : [p.arg];
			const array = ddl
				? `array[${values.map((value) => literal(value, 'text')).join(', ')}]::text[]`
				: `ARRAY(SELECT jsonb_array_elements_text(${c.p(values)}::jsonb))`;
			return leaf(`${col(p.field)} ${p.op === 'hasAny' ? '&&' : '@>'} ${array}`);
		}
		case 'period': {
			const field = fields?.get(p.field),
				date = field?.periodOf === 'date';
			if (ddl && p.op !== 'contains' && p.arg._tag === 'Lit' && Predicate.isObject(p.arg.value)) {
				const value = p.arg.value,
					type = date ? 'date' : 'timestamptz';
				const range = `${date ? 'daterange' : 'tstzrange'}(${literal(value[date ? 'from' : 'start'] ?? null, type)}, ${literal(value[date ? 'to' : 'end'] ?? null, type)}, '${date ? '[]' : '[)'}')`;
				return leaf(`${col(p.field)} ${p.op === 'overlaps' ? '&&' : '<@'} ${range}`);
			}
			return leaf(
				`${col(p.field)} ${p.op === 'contains' ? '@>' : p.op === 'overlaps' ? '&&' : '<@'} ${val(p.arg, p.field, p.op === 'contains' ? (date ? 'date' : 'timestamptz') : field?.pg)}`
			);
		}
		case 'json':
			return leaf(
				'contains' in p
					? `${col(p.field)} @> ${literal(p.contains, 'jsonb')}`
					: `(${col(p.field)} = '[]'::jsonb) = ${p.isEmpty}`
			);
		case 'one':
		case 'many':
		case 'count':
		case 'agg':
			throw BoltError.make(
				'invalidWhere',
				'derive',
				`a same-row where cannot reach the relation '${p.rel}'`
			);
		default:
			throw BoltError.make('invalidWhere', 'derive', `a same-row where cannot use '${p.t}'`);
	}
}

/**
 * Wire decimals (`$dec`) → their text, which Postgres casts per column; dates and instants are ISO strings. With the column's field, a
 * period becomes its range literal (X-11): a date period `{ from, to }` is inclusive `[from,to]` (Postgres stores
 * `[from,to+1)`), an instant period `{ start, end }` closed-open; a null end is open; a point `(lng,lat)`.
 */
export function databaseValue(v: Json, f?: Pick<FieldInfo, 'kind' | 'periodOf'>): Json {
	if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
		const o = v as { readonly [k: string]: Json },
			keys = Object.keys(o);
		if (keys.length === 1 && keys[0] === '$dec') return o[keys[0]]!;
		// a point `{ lat, lng }` is a Postgres `point` literal (x = lng, y = lat)
		if (f?.kind === 'point') return `(${String(o['lng'])},${String(o['lat'])})`;
		if (f?.kind === 'period') {
			const [lo, hi] = f.periodOf === 'date' ? [o['from'], o['to']] : [o['start'], o['end']];
			return `[${String(databaseValue(lo ?? null))},${hi == null ? '' : String(databaseValue(hi))}${f.periodOf === 'date' ? ']' : ')'}`;
		}
	}
	return v;
}

/**
 * One field's stored columns (`databaseValue`ged): an exclusive arc's `RecordRef` spreads over its arm columns `<fk>__<arm>`,
 * the named arm holding the id and every other arm null (the arc CHECK allows at most one); `null` clears them all.
 */
export function cells(
	k: string,
	v: Json,
	f?: Pick<FieldInfo, 'kind' | 'periodOf' | 'arms' | 'column'>
): [string, Json][] {
	if (f?.arms === undefined) return [[k, databaseValue(v, f)]];
	const ref = v as { collection?: Json; id?: Json } | null;
	return f.arms.map((arm) => [
		`${f.column}__${arm}`,
		ref?.collection === arm ? (ref.id ?? null) : null
	]);
}

// ── SQLSTATE → outcome (rule 20 "Postgres-decided outcomes"): the schema area's map, plus `bolt_assert`'s codes ──
type Decided = { outcome: Outcome; record: boolean; replay: boolean };
export function decided(e: unknown, constraints: ReadonlyMap<string, ConstraintMeta>): Decided {
	if (!(e instanceof DbError)) throw e;
	if (e.sqlstate === 'BA001') {
		// `bolt_assert` raises `<code> <detail>`: the DbError contract carries the message, not Postgres's DETAIL
		const space = e.message.indexOf(' ');
		const [code, detail] =
			space < 0 ? [e.message, ''] : [e.message.slice(0, space), e.message.slice(space + 1)];
		if (code === 'conflict')
			return {
				outcome: { kind: 'conflict', records: conflictRecords(detail) },
				record: true,
				replay: false
			};
		// rule 26: a transform read moved between the read and the commit: replayed once, then `conflict`
		if (code === 'fingerprint')
			return { outcome: { kind: 'conflict', records: [] }, record: true, replay: true };
		// a recorded `rateLimited` would answer the client's resend after `retryAfter` for 24 h (rule 20)
		if (code === 'rateLimited')
			return {
				outcome: { kind: 'refused', code, message: 'Too many requests; try again later.' },
				record: false,
				replay: false
			};
		// the approval lock (lock.ts): `<request id> <who may change it>`
		if (code === 'underApproval') {
			const at = detail.indexOf(' ');
			return {
				outcome: {
					kind: 'refused',
					code: 'locked',
					message: detail.slice(at + 1),
					data: { requestId: detail.slice(0, at) }
				},
				record: true,
				replay: false
			};
		}
		if (code === 'sourceChanged')
			return {
				outcome: {
					kind: 'refused',
					code,
					message: 'The integration configuration changed before this write could commit.'
				},
				record: true,
				replay: false
			};
		return {
			outcome: {
				kind: 'refused',
				code: 'locked',
				message: 'The parent record is locked in its current state.'
			},
			record: true,
			replay: false
		};
	}
	const r = refusalOf(e, constraints);
	if (r instanceof BoltError) throw r;
	return r === 'conflict'
		? { outcome: { kind: 'conflict', records: [] }, record: true, replay: true }
		: { outcome: r, record: true, replay: false };
}
const ConflictDetail = Schema.fromJsonString(
	Schema.Struct({
		collection: Schema.String,
		ids: Schema.Array(Schema.String)
	})
);
const conflictRecords = (detail: string): { collection: string; id: string; fields: string[] }[] =>
	Result.match(Schema.decodeUnknownResult(ConflictDetail)(detail), {
		onSuccess: ({ collection, ids }) => ids.map((id) => ({ collection, id, fields: [] })),
		onFailure: () => []
	});

// ── hashing and ids (rules 24, 31) ──
/** Canonical JSON drops absent members, preserving the same value as the wire. */
export const canonical = (v: unknown): string =>
	JSON.stringify(v, (_k, x: unknown) =>
		x !== null && typeof x === 'object' && !Array.isArray(x)
			? Object.fromEntries(
					Object.entries(x)
						.filter(([, value]) => value !== undefined)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				)
			: x
	);
export const sha256Hex = (input: string | Uint8Array): string =>
	createHash('sha256').update(input).digest('hex');
export const hex = (b: Uint8Array): string =>
	[...b].map((x) => x.toString(16).padStart(2, '0')).join('');
/**
 * Ids minted inside an invocation derive from `(invocationId, n)` (rule 24): a uuidv7 whose time is the invocation's
 * `now` and whose random bits are the invocation's hash with `n` folded in, so a replay mints the same ids.
 */
export function minter(invocationId: string, now: string): () => string {
	const seed = new Uint8Array(createHash('sha256').update(`mint:${invocationId}`).digest());
	const ms = Date.parse(now);
	let n = 0;
	return () => {
		const b = seed.slice(0, 16);
		for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
		const k = n++;
		b[12]! ^= (k >>> 24) & 0xff;
		b[13]! ^= (k >>> 16) & 0xff;
		b[14]! ^= (k >>> 8) & 0xff;
		b[15]! ^= k & 0xff;
		b[6] = (b[6]! & 0x0f) | 0x70;
		b[8] = (b[8]! & 0x3f) | 0x80;
		const h = hex(b);
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
	};
}

// ── rule 26: optimistic transform reads ──
/** A read statement and the digest of its rows as they were read. */
export type Fingerprint = { sql: Sql; digest: string };
const digestOf = (text: string): string =>
	`(SELECT md5(coalesce(string_agg(to_jsonb(s)::text, E'\\n'), '')) FROM (${text}) s)`;
/**
 * Wraps a `TenantDb` so every read statement is fingerprinted in the same statement: its rows, then its digest as a
 * last row, in one snapshot. The commit re-computes each digest under its table lock and asserts it.
 */
export function fingerprinting(db: TenantDbShape): {
	db: TenantDbShape;
	fingerprints(): readonly Fingerprint[];
} {
	const taken: Fingerprint[] = [];
	return {
		fingerprints: () => taken,
		db: TenantDb.typed({
			...db,
			read: Effect.fn('Bolt.fingerprinting')(function* (statements: readonly Sql[]) {
				const res = yield* db.read(
					statements.map((s) =>
						composable({
							text: `SELECT false AS fp, to_jsonb(x) AS r FROM (${s.text}) x
UNION ALL SELECT true, to_jsonb(${digestOf(s.text)})`,
							params: s.params
						})
					)
				);
				return res.map((r, i) => {
					const rows = r.rows.filter((x) => x['fp'] !== true).map((x) => x['r'] as RowData);
					taken.push({
						sql: statements[i]!,
						digest: String(r.rows.find((x) => x['fp'] === true)!['r'])
					});
					return { rows, affected: rows.length };
				});
			})
		})
	};
}
/** One assert per fingerprint: the rows read then are the rows now (rule 26). */
export function fingerprintAsserts(c: Chain, fps: readonly Fingerprint[]): void {
	for (const f of fps) c.assert(`${digestOf(inline(f.sql))} = ${c.p(f.digest)}`, 'fingerprint');
}
