// The write area's SQL plumbing (A5): the `WITH` chain builder behind rule 20's one statement, its idempotency gate and
// outcome, notices and rate charges, the SQLSTATE map (G3), invocation-minted ids and the transform's fingerprints.
import type { Json } from '../../decl/values.ts';
import type { TeamEntries } from '../../decl/access/team.ts';
import { teamEntries } from '../manifest.ts';
import { Effect, Result, Schema } from 'effect';
import { LIMITS, type Outcome, type RowData, type Sql } from '../contracts.ts';
import { canonical, sha256, type ConstraintMeta } from '@norbital-ai/store';
import {
	TenantDb,
	type RawDb,
	type SqlReadCaptureService,
	type TenantDbShape
} from '../db/tenant-db.ts';
import { DbError } from '../errors.ts';
import { copiedSql, dbError, inline } from '../db/wire.ts';
import { composable } from '../query/reader.ts';
import { BoltError } from '../../protocol/errors.ts';
import { refusalOf } from '../schema/refusal.ts';

/** The idempotency gate's condition (rule 20): every data-modifying piece reads its rows through it. */
export const GATED = 'EXISTS (SELECT 1 FROM idem)';

/**
 * One in-app notice per active staff recipient, plus one external delivery row per `via` connection. `rows` are
 * `noticeRows`' (engine/notifications/notify.ts): `to` is the expanded recipient list, `attachments` the notice's files.
 */
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
		AS v(id text, "to" jsonb, via jsonb, title text, body text, link jsonb, once text, attachments jsonb)`
		),
		c.cte(
			`${name}_to`,
			`SELECT v.id || ':' || mem.id AS id, v.id AS notice,
		jsonb_build_object('channel', 'inbox', 'recipients', v."to") AS "to", mem.id AS member,
		v.title, v.body, v.link, v.once || ':' || mem.id AS once, v.attachments
	FROM ${name}_source v LEFT JOIN LATERAL (SELECT u.id FROM sys_user u
		WHERE u.active AND u.kind = 'staff' AND EXISTS (SELECT 1 FROM jsonb_array_elements(v."to") r
			WHERE r->>'user' = u.id OR (r->>'team' = u.team AND ${policies}::jsonb ? u.team)
				OR EXISTS (SELECT 1 FROM jsonb_each(${policies}::jsonb) s
					WHERE s.key = u.team AND s.value ? (r->>'policy'))
				OR (u.signup AND ${c.p(signup)}::jsonb ? (r->>'policy')))) mem ON true
	UNION ALL SELECT v.id || ':' || ch, v.id, jsonb_build_object('channel', ch, 'recipients', v."to"), NULL::text,
		v.title, v.body, v.link, v.once || ':' || ch, v.attachments
	FROM ${name}_source v CROSS JOIN LATERAL jsonb_array_elements_text(v.via) ch`
		),
		c.cte(
			name,
			`INSERT INTO sys_notification (id, recipient, member, title, body, link, once, attachments, at)
	SELECT id, "to", member, title, body, link, once, attachments, ${c.p(now)}::timestamptz FROM ${name}_to
	WHERE (member IS NOT NULL OR "to"->>'channel' <> 'inbox') AND (${when}) ON CONFLICT (once) DO NOTHING
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
	WHERE bolt_idem.issued_at < excluded.issued_at - interval '24 hours'
	AND NOT EXISTS (SELECT 1 FROM bolt_audit_receipt a WHERE a.outcome_key=bolt_idem.key AND a.acknowledged_at IS NULL AND a.expired_at IS NULL) RETURNING key`
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

// ── ids (rules 24, 31) ──
export const hex = (b: Uint8Array): string =>
	[...b].map((x) => x.toString(16).padStart(2, '0')).join('');
/**
 * Ids minted inside an invocation derive from `(invocationId, n)` (rule 24): a uuidv7 whose time is the invocation's
 * `now` and whose random bits are the invocation's hash with `n` folded in, so a replay mints the same ids.
 */
export function minter(invocationId: string, now: string): () => string {
	const seed = sha256(`mint:${invocationId}`);
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
/** Native read dependencies retained until a fresh act commits them. */
export type ReadGuards = {
	readonly sourceEpoch: string;
	readonly fingerprints: readonly Fingerprint[];
	readonly tables: readonly string[];
	readonly inconsistent?: true;
};
export const digestOf = (text: string): string =>
	`(SELECT md5(coalesce(string_agg(to_jsonb(s)::text, E'\\n'), '')) FROM (${text}) s)`;

const FingerprintRow = Schema.Union([
	Schema.Struct({ fp: Schema.Literal(false), r: Schema.Record(Schema.String, Schema.Json) }),
	Schema.Struct({ fp: Schema.Literal(true), r: Schema.String })
]);
/** Rows and membership are fingerprinted in their native statement's snapshot, before any decoding crossing. */
const readFingerprints = Effect.fn('Bolt.readFingerprints')(function* (
	statements: readonly Sql[],
	execute: RawDb['read']
) {
	const originals = yield* Effect.try({
		try: () => Array.from(statements, copiedSql),
		catch: dbError
	});
	const answers = yield* execute(
		originals.map((s) =>
			composable({
				text: `SELECT false AS fp, to_jsonb(x) AS r FROM (${s.text}) x
UNION ALL SELECT true, to_jsonb(${digestOf(s.text)})`,
				params: s.params
			})
		)
	);
	if (answers.length !== originals.length)
		return yield* DbError.make(
			'08P01',
			'a fingerprinted read returned the wrong number of answers'
		);
	const fingerprints: Fingerprint[] = [];
	const rows = yield* Effect.forEach(originals, (sql, i) =>
		Effect.gen(function* () {
			const answer = answers[i];
			if (answer === undefined)
				return yield* DbError.make('08P01', 'a fingerprinted read returned no answer');
			const envelope = yield* Schema.decodeUnknownEffect(Schema.Array(FingerprintRow))(
				answer.rows
			).pipe(Effect.mapError((cause) => DbError.make('08P01', cause.message)));
			const values: RowData[] = [];
			let digest: string | undefined;
			for (const row of envelope) {
				if (row.fp) digest = row.r;
				else values.push(row.r);
			}
			if (digest === undefined)
				return yield* DbError.make('08P01', 'a fingerprinted read returned no digest');
			fingerprints.push({ sql, digest });
			return { rows: values, affected: values.length };
		})
	);
	return { rows, fingerprints };
});

/** Captures stay private until the entire crossing succeeds; newer reads survive an older act's consumption. */
export function makeReadGuards(sourceEpoch: string) {
	type Entry = { fingerprint: Fingerprint; tables: readonly string[]; generation: number };
	let published = new Map<string, Entry>();
	let generation = 0;
	let inconsistent = false;
	return {
		begin(tables: ReadonlySet<string>): { capture: SqlReadCaptureService; finish: () => void } {
			const pending = new Map<string, Fingerprint>();
			let changed = false;
			return {
				capture: {
					read: Effect.fn('Bolt.captureReadGuards')(function* (
						statements: readonly Sql[],
						execute: RawDb['read']
					) {
						const captured = yield* readFingerprints(statements, execute);
						for (const fingerprint of captured.fingerprints) {
							const key = canonical(fingerprint.sql);
							const first = pending.get(key) ?? published.get(key)?.fingerprint;
							if (first !== undefined && first.digest !== fingerprint.digest) changed = true;
							if (!pending.has(key)) pending.set(key, first ?? fingerprint);
						}
						return captured.rows;
					})
				},
				finish() {
					const next = new Map(published);
					const nextGeneration = generation + 1;
					const dependencies = [...tables].sort();
					for (const [key, fingerprint] of pending) {
						const first = published.get(key);
						if (first !== undefined && first.fingerprint.digest !== fingerprint.digest)
							changed = true;
						next.set(key, {
							fingerprint: first?.fingerprint ?? fingerprint,
							tables: [...new Set([...(first?.tables ?? []), ...dependencies])].sort(),
							generation: nextGeneration
						});
					}
					if (inconsistent || changed) {
						inconsistent = true;
						generation = nextGeneration;
						throw BoltError.make(
							'conflict',
							'admission',
							'a repeated native read changed during this automation attempt; start a fresh attempt'
						);
					}
					const heldTables = new Set([...next.values()].flatMap((entry) => entry.tables));
					const encoder = new TextEncoder();
					const bytes =
						[...next.keys()].reduce((size, key) => size + encoder.encode(key).byteLength, 0) +
						encoder.encode(canonical([...heldTables].sort())).byteLength;
					if (next.size > LIMITS.readGuards.count || bytes > LIMITS.readGuards.bytes)
						throw BoltError.make(
							'readBudgetExceeded',
							'admission',
							`retained native reads exceed ${LIMITS.readGuards.count} statements or ${LIMITS.readGuards.bytes} bytes`
						);
					published = next;
					generation = nextGeneration;
				}
			};
		},
		snapshot(): { generation: number; guards: ReadGuards } {
			const entries = [...published.values()];
			const guards: ReadGuards = {
				sourceEpoch,
				fingerprints: entries.map((entry) => entry.fingerprint),
				tables: [...new Set(entries.flatMap((entry) => entry.tables))].sort()
			};
			return inconsistent
				? { generation, guards: { ...guards, inconsistent: true } }
				: { generation, guards };
		},
		consume(consumed: number): void {
			for (const [key, entry] of published) if (entry.generation <= consumed) published.delete(key);
		}
	};
}
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
				const captured = yield* readFingerprints(statements, db.read);
				taken.push(...captured.fingerprints);
				return captured.rows;
			})
		})
	};
}
/** One assert per fingerprint: the rows read then are the rows now (rule 26). */
export function fingerprintAsserts(c: Chain, fps: readonly Fingerprint[]): void {
	for (const f of fps) c.assert(`${digestOf(inline(f.sql))} = ${c.p(f.digest)}`, 'fingerprint');
}
