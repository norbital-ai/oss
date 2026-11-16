// Uploads reuse content and metadata within one actor and destination. Request keys use the native
// idempotency gate; bytes remain content-addressed by the host's files port.
import { Effect, Schema } from 'effect';
import { UUID_PATTERN } from '@norbital-ai/store/kind';
import { LIMITS, type Authority, type Outcome } from '../contracts.ts';
import { layered, layers, type EngineManifest } from '../manifest.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Manifest } from '../services.ts';
import { Files } from '../ports.ts';
import { sha256 as sha256Of, sha256_hex, to_hex } from '@norbital-ai/store';
import { BoltError } from '../../protocol/errors.ts';
import { RATE_LIMITED } from '../../protocol/wire.ts';
import type { RateCharge } from '../write/commit.ts';
import { Chain, GATED, gate, answer, storedOutcome, rate } from '../write/sql.ts';
import { actor_ref } from '../access/actor.ts';
import { stableId } from '../conversations/store.ts';
import { WriteOutcome } from '../../protocol/schema.ts';
import { ATTACHMENT_MIME } from '../agent/ai.ts'; // hook:attachments
import { acceptOf, parserFor, parsersOf } from '../files/parse.ts';

/** The `Bolt-Stored` header: an upload's blob as the host stored it. */
export const StoredUpload = /*#__PURE__*/ Schema.fromJsonString(
	Schema.Struct({ key: Schema.String, bytes: Schema.Number, sha256: Schema.String })
);
type Upload = {
	id: string;
	model: string;
	field: string;
	name: string;
	mime: string;
	bytes: Uint8Array;
	/** The host stored the body already, and `bytes` is empty: what it stored. */
	stored?: typeof StoredUpload.Type;
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
const SIZE = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 } as const;
/** `'5MiB'` → bytes. */
export const size_bytes = (s: string): number => {
	const m = /^(\d+)(KiB|MiB|GiB)$/.exec(s);
	return m === null ? NaN : Number(m[1]) * SIZE[m[2] === 'KiB' ? 'KiB' : m[2] === 'MiB' ? 'MiB' : 'GiB'];
};
/** A file no field declares a cap for: what the object store holds. */
const UNBOUNDED = '1024GiB';
// `*/*` is any type, an empty or unknown one included (a browser sends '' for an extension it cannot name)
const accepts = (patterns: readonly string[], mime: string) =>
	patterns.some(
		(p) => p === '*/*' || p === mime || (p.endsWith('/*') && mime.startsWith(p.slice(0, -1)))
	);

/** Uploads follow the declared write path, including a child file written through its parent; visitors hold create paths only. */
function admits(m: EngineManifest, auth: Authority, c: string, field: string): boolean {
	const models = layers(m);
	for (const [root, spec] of Object.entries(layered(m).exposures))
		for (const verb of auth.actor.kind === 'visitor' ? ['create'] as const : ['create', 'update'] as const)
			for (const [path, fields] of Object.entries(spec[verb]?.columns ?? {})) {
				if (models[root]?.[path] !== c || !fields.includes(field)) continue;
				if (auth.admin || auth.models[root]?.[verb].some((arm) => arm.columns[path]?.includes(field)))
					return true;
			}
	return false;
}

export const upload = Effect.fn('Callables.upload')(function* (u: Upload) {
	const manifest = yield* Manifest;
	const db = yield* TenantDb;
	const files = yield* Files;
	// hook:attachments — the agent panel's own field: any member stores a conversation input; `sys_message.post` checks the message's 8 files / 20 MiB
	const panel = u.model === 'sys_conversation' && u.field === 'inputs';
	// a file sync's upload (`<m>.$import.<sync>`, read back by its `<m>.sync.<sync>` run): a member who may create or update
	// in `m`, sending a file one of the sync's parsers reads (by extension or media type); any other is refused unread
	const sync = u.field.startsWith('$import.')
		? manifest.exposures[u.model]?.syncs?.[u.field.slice('$import.'.length)]
		: undefined;
	const parsers = sync?.with === 'file' ? parsersOf(sync) : null;
	// an automation's `file` input (`<automation>.$input.<input>`): a member who may start it; the file is the
	// automation's, so its runs read it
	const input = u.field.startsWith('$input.')
		? manifest.automations[u.model]?.input?.[u.field.slice('$input.'.length)]
		: undefined;
	const kind =
		panel || parsers !== null
			? { kind: 'file' as const, accept: [], max: UNBOUNDED }
			: input !== undefined
				? input.kind === 'file'
					? input
					: undefined
				: manifest.models[u.model]?.fields[u.field];
	const size = u.stored?.bytes ?? u.bytes.byteLength;
	const allowed = panel
		? u.authority.actor.kind === 'member'
		: input !== undefined
			? u.authority.actor.kind === 'member' &&
				(u.authority.admin || u.authority.automations.includes(u.model))
			: parsers !== null
			? u.authority.actor.kind === 'member' &&
				(u.authority.admin ||
					(u.authority.models[u.model]?.create.length ?? 0) > 0 ||
					(u.authority.models[u.model]?.update.length ?? 0) > 0)
			: admits(manifest, u.authority, u.model, u.field);
	if (kind?.kind !== 'file' || !allowed)
		return refuse('forbidden', `You may not upload to ${u.model}.${u.field}.`);
	if (!UUID_PATTERN.test(u.id))
		return refuse('invalid_input', 'An upload request key is a client-minted uuid.');
	if (
		panel
			? !ATTACHMENT_MIME.test(u.mime) || size === 0
			: parsers !== null
				? parserFor(parsers, u.name, u.mime) === undefined
				: !accepts(kind.accept, u.mime)
	)
		return refuse(
			'invalid_input',
			panel
				? 'Attach a nonempty image, document, spreadsheet, slides, recording or text file.'
				: `${u.field} accepts ${parsers !== null ? acceptOf(parsers) : kind.accept.join(', ')}.`
		);
	// bytes the host stored never entered this cell, so only the field's own cap applies to them
	if (size > (u.stored === undefined ? Math.min(size_bytes(kind.max), LIMITS.storedFileBytes) : size_bytes(kind.max)))
		return refuse('invalid_input', `${u.field} holds at most ${kind.max}.`);
	const blob =
		u.stored ??
		(yield* files
			.put(u.bytes, { name: u.name, mime: u.mime })
			.pipe(Effect.mapError((error) => BoltError.make('upload', 'facility', error.message, error))));
	const sha256 = u.stored?.sha256 ?? to_hex(sha256Of(u.bytes));
	const field = input === undefined ? `${u.model}.${u.field}` : u.model;
	const actor = actor_ref(u.authority.actor);
	const identity = [actor, field, u.name, u.mime, sha256];
	const id = stableId('file', ...identity);
	const key = stableId('upload', actor, u.id);
	const digest = sha256_hex(JSON.stringify([...identity, size]));
	const c = new Chain();
	gate(c, key, digest, u.now);
	c.cte(
		'uploaded',
		`INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by)
	SELECT ${c.p(id)}, ${c.p(u.name)}, ${c.p(u.mime)}, ${c.p(size)}, ${c.p(blob.key)}, ${c.p(sha256)}, ${c.p(field)},
		${c.p(u.now)}::timestamptz, ${c.p(u.authority.actor.kind === 'member' ? u.authority.actor.id : null)} WHERE ${GATED}
	ON CONFLICT (id) DO UPDATE SET id = excluded.id RETURNING id, name, mime, size, sha256`
	);
	rate(c, u.rate ?? []);
	const result = yield* db.returning(
		Schema.Struct({ outcome: Schema.NullOr(WriteOutcome) }),
		c.sql(answer(c, key, digest, `(SELECT jsonb_build_object('kind', 'committed', 'records', '[]'::jsonb,
			'output', jsonb_build_object('id', id, 'name', name, 'mime', mime, 'bytes', size, 'sha256', sha256)) FROM uploaded)`))
	).pipe(Effect.catchTag('DbError', (error) =>
				error.sqlstate === 'BA001' ? Effect.succeed([]) : Effect.fail(error)
			));
	const row = result[0];
	if (row === undefined) return refuse('rate_limited', RATE_LIMITED);
	// A concurrent retry may have waited for the gate after this statement's snapshot was taken.
	return row.outcome ?? (yield* db.value(WriteOutcome, {
		text: `SELECT ${storedOutcome('$1', '$2')} AS outcome`, params: [key, digest]
	}));
});
