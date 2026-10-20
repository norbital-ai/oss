import { Crypto, Effect, Option, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { TenantTx, type TenantDbShape } from '../db/tenant-db.ts';
import { Fenced, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { SecretsCodec } from '../secrets.ts';

const InstanceRowSchema = Schema.Struct({
	integration: Schema.String,
	owner: Schema.NullOr(Schema.String),
	active: Schema.Boolean,
	configuration: Schema.Json,
	import_start: Schema.NullOr(Schema.Json)
});
export type InstanceRow = typeof InstanceRowSchema.Type;
export type Credentials = {
	readonly open: (
		instance: string
	) => Effect.Effect<
		{ epoch: string; row: InstanceRow; values: ReadonlyMap<string, Json> },
		EngineError
	>;
	readonly read: (
		instance: string
	) => Effect.Effect<
		{ epoch: string | null; row: InstanceRow; values: ReadonlyMap<string, Json> },
		EngineError
	>;
	readonly write: (
		instance: string,
		epoch: string | null,
		changes: ReadonlyMap<string, Json | null>,
		rotate?: boolean
	) => Effect.Effect<string | null, EngineError>;
};
const Sealed = Schema.Struct({ name: Schema.String, sealed: Schema.String });
const Loaded = Schema.Struct({
	...InstanceRowSchema.fields,
	epoch: Schema.NullOr(Schema.String),
	sealed: Schema.Array(Sealed)
});
const Fence = Schema.Struct({ held: Schema.Number, known: Schema.Boolean });
const owner = (instance: string) => `instance:${instance}`;
const ROW = 'integration, owner, active, configuration, import_start';
const unknown = (instance: string) =>
	BoltError.make('notFound', 'facility', `no integration instance '${instance}'`);
const invalid = (name: string) =>
	BoltError.make('sealed', 'facility', `the credential '${name}' is not sealed JSON`);

export const credentials = Effect.fn('Credentials.make')(function* (
	db: TenantDbShape,
	codec: SecretsCodec
): Effect.fn.Return<Credentials, never, Crypto.Crypto> {
	const crypto = yield* Crypto.Crypto;
	const uuid = crypto.randomUUIDv4.pipe(
		Effect.mapError((error) =>
			BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
		)
	);
	const opened = (instance: string, rows: readonly (typeof Sealed.Type)[]) =>
		Effect.forEach(rows, (r) =>
			Effect.gen(function* () {
				const value = codec.open(owner(instance), r.name, r.sealed);
				if (Option.isNone(value))
					return yield* Effect.fail(
						BoltError.make(
							'sealed',
							'facility',
							`the credential '${r.name}' of '${instance}' does not open with this tenant's key`
						)
					);
				const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
					value.value
				).pipe(Effect.mapError(() => invalid(r.name)));
				return [r.name, decoded] as const;
			})
		).pipe(Effect.map((entries) => new Map(entries)));
	return {
		open: (instance) =>
			db.transaction(
				Effect.gen(function* () {
					const tx = yield* TenantTx;
					const epoch = yield* uuid;
					const bumped = yield* tx.query({
						text: `UPDATE sys_integration SET epoch = $2 WHERE id = $1 RETURNING ${ROW}`,
						params: [instance, epoch]
					});
					const raw = bumped.rows[0];
					if (raw === undefined) return yield* Effect.fail(unknown(instance));
					const row = yield* Schema.decodeUnknownEffect(InstanceRowSchema)(raw).pipe(
						Effect.mapError(() => unknown(instance))
					);
					const sealed = yield* tx.query({
						text: 'SELECT name, sealed FROM bolt_credential WHERE instance = $1',
						params: [instance]
					});
					const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Sealed))(sealed.rows).pipe(
						Effect.mapError(() => invalid(instance))
					);
					return { epoch, row, values: yield* opened(instance, rows) };
				})
			),
		read: (instance) =>
			Effect.gen(function* () {
				const found = yield* db.one(Loaded, {
					text: `SELECT ${ROW}, epoch, coalesce((SELECT jsonb_agg(jsonb_build_object('name', c.name, 'sealed', c.sealed)) FROM bolt_credential c WHERE c.instance = i.id), '[]'::jsonb) AS sealed FROM sys_integration i WHERE i.id = $1`,
					params: [instance]
				});
				if (Option.isNone(found)) return yield* Effect.fail(unknown(instance));
				const { epoch, sealed, ...row } = found.value;
				return { epoch, row, values: yield* opened(instance, sealed) };
			}),
		write: (instance, epoch, changes, rotate = false) =>
			Effect.gen(function* () {
				const set = yield* Effect.forEach(
					[...changes].filter((entry): entry is [string, Json] => entry[1] !== null),
					([name, value]) =>
						codec
							.seal(owner(instance), name, JSON.stringify(value))
							.pipe(Effect.map((sealed) => ({ name, sealed })))
				);
				const unset = [...changes].flatMap(([name, value]) => (value === null ? [name] : []));
				const next = rotate ? yield* uuid : epoch;
				const rows = yield* db.returning(Fence, {
					text: `WITH fence AS (SELECT id FROM sys_integration WHERE id = $1 AND epoch IS NOT DISTINCT FROM $2 FOR UPDATE),
			moved AS (UPDATE sys_integration SET epoch = $5::text WHERE $6::boolean AND id IN (SELECT id FROM fence) RETURNING 1),
			up AS (INSERT INTO bolt_credential (instance, name, sealed) SELECT $1, v.name, v.sealed FROM jsonb_to_recordset($3::jsonb) AS v(name text, sealed text) WHERE EXISTS (SELECT 1 FROM fence) ON CONFLICT (instance, name) DO UPDATE SET sealed = excluded.sealed RETURNING 1),
			gone AS (DELETE FROM bolt_credential WHERE instance = $1 AND name IN (SELECT jsonb_array_elements_text($4::jsonb)) AND EXISTS (SELECT 1 FROM fence) RETURNING 1)
			SELECT (SELECT count(*) FROM fence)::int AS held, EXISTS (SELECT 1 FROM sys_integration WHERE id = $1) AS known`,
					params: [instance, epoch, JSON.stringify(set), JSON.stringify(unset), next, rotate]
				});
				const row = rows[0];
				if (row?.known !== true) return yield* Effect.fail(unknown(instance));
				if (row.held !== 1)
					return yield* Effect.fail(
						new Fenced({
							instance,
							message: `another link took '${instance}' since this one read its credentials`
						})
					);
				return next;
			})
	};
});
