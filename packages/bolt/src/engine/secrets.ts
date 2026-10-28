// Secrets sealed by the host's key (`Keys`, AES-256-GCM, bound to owner/name by its `aad`): the engine never holds the
// key. The workspace's live ConfigProvider reads the declared sealed values.
import { ConfigProvider, Context, Effect, Layer, Option, Schema } from 'effect';
import { TenantDb } from './db/tenant-db.ts';
import { type DbError } from './errors.ts';
import { BoltError } from '../protocol/errors.ts';
import { Keys } from './ports.ts';
import type { PortFailure } from './port.ts';
import { fromBase64, toBase64 } from './crypto.ts';

export type SecretsCodec = {
	readonly seal: (owner: string, name: string, value: string) => Effect.Effect<string, BoltError>;
	/** `None` for an envelope that does not open under this tenant's key, owner and name. */
	readonly open: (
		owner: string,
		name: string,
		envelope: string
	) => Effect.Effect<Option.Option<string>, BoltError>;
};
export type SecretsShape = SecretsCodec & {
	readonly status: (
		owner: string
	) => Effect.Effect<{ readonly [name: string]: boolean }, DbError | BoltError>;
	readonly set: (
		owner: string,
		name: string,
		value: string
	) => Effect.Effect<void, DbError | BoltError>;
	readonly clear: (owner: string, name: string) => Effect.Effect<void, DbError>;
	readonly config: ConfigProvider.ConfigProvider;
};
const prefix = (owner: string) => `secret:${owner}:`;
const stored = Schema.Struct({ key: Schema.String, value: Schema.String });
export class Secrets extends Context.Service<Secrets, SecretsShape>()('bolt/Secrets') {
	static readonly layer = (declared: readonly string[]) =>
		Layer.effect(
			Secrets,
			Effect.gen(function* () {
				const db = yield* TenantDb;
				const keys = yield* Keys;
				const workspace = new Map<string, string>();
				const aad = (owner: string, name: string) =>
					new TextEncoder().encode(`bolt\u0000${owner}\u0000${name}`);
				const failed = (message: string) => (error: PortFailure) =>
					error._tag === 'Unavailable'
						? BoltError.make('unavailable', 'facility', 'this activation has no secrets key')
						: BoltError.make('internal', 'facility', message, error);
				const seal = Effect.fn('Secrets.seal')(function* (
					owner: string,
					name: string,
					value: string
				) {
					const sealed = yield* keys
						.seal(new TextEncoder().encode(value), aad(owner, name))
						.pipe(Effect.mapError(failed('the secret could not be sealed')));
					return toBase64(sealed);
				});
				// copied envelopes cannot open under another owner/name
				const open = (owner: string, name: string, envelope: string) =>
					keys
						.open(fromBase64(envelope), aad(owner, name))
						.pipe(
							Effect.map(Option.map((plain) => new TextDecoder().decode(plain))),
							Effect.mapError(failed('the secret could not be opened'))
						);
				const rows = yield* db.rows(stored.annotate({ identifier: 'sys_config' }), {
					text: 'SELECT key, value FROM sys_config WHERE key LIKE $1',
					params: [`${prefix('workspace')}%`]
				});
				for (const row of rows) {
					const name = row.key.slice(prefix('workspace').length);
					const value = yield* open('workspace', name, row.value);
					if (Option.isSome(value)) workspace.set(name, value.value);
				}
				const config = ConfigProvider.make((path) =>
					ConfigProvider.fromUnknown(
						Object.fromEntries(
							declared.flatMap((name) => {
								const value = workspace.get(name);
								return value === undefined ? [] : [[name, value]];
							})
						)
					).load(path)
				);
				return Secrets.of({
					seal,
					open,
					config,
					status: Effect.fn('Secrets.status')(function* (owner) {
						const answer = yield* db.rows(
							Schema.Struct({ key: Schema.String }).annotate({ identifier: 'sys_config' }),
							{
								text: 'SELECT key FROM sys_config WHERE key LIKE $1',
								params: [`${prefix(owner)}%`]
							}
						);
						const set = new Set(answer.map((row) => row.key.slice(prefix(owner).length)));
						return Object.fromEntries(
							(owner === 'workspace' ? declared : [...set]).map((name) => [name, set.has(name)])
						);
					}),
					set: Effect.fn('Secrets.set')(function* (owner, name, value) {
						if (owner === 'workspace' && !declared.includes(name))
							return yield* Effect.fail(
								BoltError.make('invalid', 'facility', `'${name}' is not a declared secret`)
							);
						const envelope = yield* seal(owner, name, value);
						yield* db.write({
							text: 'INSERT INTO sys_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
							params: [prefix(owner) + name, envelope]
						});
						if (owner === 'workspace') workspace.set(name, value);
					}),
					clear: Effect.fn('Secrets.clear')(function* (owner, name) {
						yield* db.write({
							text: 'DELETE FROM sys_config WHERE key = $1',
							params: [prefix(owner) + name]
						});
						if (owner === 'workspace') workspace.delete(name);
					})
				});
			})
		);
}
