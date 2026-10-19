// `/files` uploads are persisted (rules 18, 38, 38d; final-domain D17): the bytes go to the files port, then one statement
// inserts the `sys_file` row keyed by the client-minted upload id and adds the `upload` rate increment gated on that
// insert, so a resent upload adds no row and no count and answers the first `FileRef`. Refused before its bytes are
// stored (grant, `accept`, `max`) it costs no statement.
import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { LIMITS, type Authority, type Outcome } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Manifest } from '../services.ts';
import { Files } from '../ports.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { RateCharge } from '../write/commit.ts';
import { Chain, KEY_REUSE, rate } from '../write/sql.ts';
import { ATTACHMENT_MIME } from '../agent/ai.ts'; // hook:attachments

type Upload = {
	id: string;
	collection: string;
	field: string;
	name: string;
	mime: string;
	bytes: Uint8Array;
	authority: Authority;
	now: string;
	rate?: readonly RateCharge[];
};
type Refused = Extract<Outcome, { kind: 'refused' }>;

const refuse = (code: Refused['code'], message: string): Refused => ({
	kind: 'refused',
	code,
	message,
	field: 'file'
});
const SIZE = { KiB: 1024, MiB: 1024 * 1024 } as const;
/** `'5MiB'` → bytes. */
export const sizeBytes = (s: string): number => {
	const m = /^(\d+)(KiB|MiB)$/.exec(s);
	return m === null ? NaN : Number(m[1]) * (m[2] === 'KiB' ? SIZE.KiB : SIZE.MiB);
};
// `*/*` is any type, an empty or unknown one included (a browser sends '' for an extension it cannot name)
const accepts = (patterns: readonly string[], mime: string) =>
	patterns.some(
		(p) => p === '*/*' || p === mime || (p.endsWith('/*') && mime.startsWith(p.slice(0, -1)))
	);

/** Rule 38d (a): a visitor uploads only to `file` fields its `create` grant writes; a member to any field its create or update grant admits. */
function admits(m: EngineManifest, auth: Authority, c: string, field: string): boolean {
	const spec = m.collections[c];
	const inputs = [
		...(spec?.create?.input.columns ?? []),
		...(auth.actor.kind === 'visitor' ? [] : (spec?.update?.input.columns ?? []))
	];
	if (!inputs.includes(field)) return false;
	if (auth.admin) return true;
	const arms = [
		...(auth.collections[c]?.create ?? []),
		...(auth.actor.kind === 'visitor' ? [] : (auth.collections[c]?.update ?? []))
	];
	return arms.some((a) => a.fields === 'all' || a.fields.includes(field));
}

export const upload = Effect.fn('Callables.upload')(function* (u: Upload) {
	const manifest = yield* Manifest;
	const db = yield* TenantDb;
	const files = yield* Files;
	// hook:attachments — the agent panel's own field: any member stores a message attachment; `sys_message.post` checks the message's 8 files / 20 MiB
	const panel = u.collection === 'sys_message' && u.field === 'files';
	// a pipeline import's file (`<c>.$import`, read back by its `<c>.pipeline` run): a member who may create in `c`
	const upload = u.field === '$import' && manifest.pipelines[u.collection]?.import !== undefined;
	const kind = panel
		? { kind: 'file' as const, accept: [], max: '20MiB' }
		: upload
			? {
					kind: 'file' as const,
					accept: [
						'application/json',
						'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
					],
					max: '20MiB'
				}
			: manifest.models[u.collection]?.fields[u.field];
	const allowed =
		panel || upload
			? u.authority.actor.kind === 'member' &&
				(panel ||
					u.authority.admin ||
					(u.authority.collections[u.collection]?.create.length ?? 0) > 0)
			: admits(manifest, u.authority, u.collection, u.field);
	if (kind?.kind !== 'file' || !allowed)
		return refuse('forbidden', `You may not upload to ${u.collection}.${u.field}.`);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u.id))
		return refuse('invalidInput', 'An upload id is a client-minted uuid.');
	if (
		panel
			? !ATTACHMENT_MIME.test(u.mime) || u.bytes.byteLength === 0
			: !accepts(kind.accept, u.mime)
	)
		return refuse(
			'invalidInput',
			panel
				? 'Attach a nonempty image, PDF, DOCX, XLSX or text document.'
				: `${u.field} accepts ${kind.accept.join(', ')}.`
		);
	if (u.bytes.byteLength > Math.min(sizeBytes(kind.max), LIMITS.storedFileBytes))
		return refuse('invalidInput', `${u.field} holds at most ${kind.max}.`);
	const sha256 = createHash('sha256').update(u.bytes).digest('hex');
	const blob = yield* files
		.put(u.bytes, { name: u.name, mime: u.mime })
		.pipe(Effect.mapError((error) => BoltError.make('upload', 'facility', error.message, error)));
	const c = new Chain();
	c.cte(
		'idem',
		`INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by)
	VALUES (${c.p(u.id)}, ${c.p(u.name)}, ${c.p(u.mime)}, ${c.p(u.bytes.byteLength)}, ${c.p(blob.key)}, ${c.p(sha256)}, ${c.p(`${u.collection}.${u.field}`)},
		${c.p(u.now)}::timestamptz, ${c.p(u.authority.actor.kind === 'member' ? u.authority.actor.id : null)})
	ON CONFLICT (id) DO NOTHING RETURNING id, name, mime, size, sha256`
	);
	rate(c, u.rate ?? []);
	const first = c.p(u.id);
	const Ref = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		mime: Schema.String,
		size: Schema.Number,
		sha256: Schema.String
	});
	const answer = yield* db
		.returning(
			Schema.Struct({ ref: Schema.NullOr(Ref) }),
			c.sql(`coalesce((SELECT to_jsonb(idem) FROM idem), (SELECT CASE WHEN f.field = ${c.p(`${u.collection}.${u.field}`)} AND f.sha256 = ${c.p(sha256)}
		THEN jsonb_build_object('id', f.id, 'name', f.name, 'mime', f.mime, 'size', f.size, 'sha256', f.sha256) END FROM sys_file f WHERE f.id = ${first})) AS ref`)
		)
		.pipe(
			Effect.catchTag('DbError', (error) =>
				error.sqlstate === 'BA001' ? Effect.succeed([]) : Effect.fail(error)
			)
		);
	const row = answer[0];
	if (row === undefined) return refuse('rateLimited', 'Too many uploads; try again later.');
	const ref = row.ref;
	return ref === null
		? KEY_REUSE
		: {
				kind: 'committed' as const,
				output: {
					id: ref.id,
					name: ref.name,
					mime: ref.mime,
					bytes: Number(ref.size),
					sha256: ref.sha256
				},
				records: []
			};
});
