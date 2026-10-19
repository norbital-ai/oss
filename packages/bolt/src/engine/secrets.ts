// AES-256-GCM envelopes bound to owner/name; the workspace's live ConfigProvider reads the declared sealed values.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigProvider, Context, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { TenantDb } from './db/tenant-db.ts';
import { type DbError } from './errors.ts';
import { BoltError } from '../protocol/errors.ts';

export type SecretsCodec = {
	readonly seal: (owner: string, name: string, value: string) => Effect.Effect<string, BoltError>;
	readonly open: (owner: string, name: string, envelope: string) => Option.Option<string>;
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
	static readonly layer = (
		declared: readonly string[],
		key: Option.Option<Redacted.Redacted<Uint8Array>>
	) =>
		Layer.effect(
			Secrets,
			Effect.gen(function* () {
				const db = yield* TenantDb;
				const workspace = new Map<string, string>();
				const aad = (owner: string, name: string) => Buffer.from(`bolt\u0000${owner}\u0000${name}`);
				const unavailable = () =>
					BoltError.make('unavailable', 'facility', 'this activation has no secrets key');
				const seal = Effect.fn('Secrets.seal')(function* (
					owner: string,
					name: string,
					value: string
				) {
					if (Option.isNone(key)) return yield* Effect.fail(unavailable());
					return yield* Effect.try({
						try: () => {
							const iv = randomBytes(12),
								cipher = createCipheriv('aes-256-gcm', Redacted.value(key.value), iv).setAAD(
									aad(owner, name)
								);
							const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
							return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
						},
						catch: () => BoltError.make('internal', 'facility', 'the secret could not be sealed')
					});
				});
				const open = (owner: string, name: string, envelope: string): Option.Option<string> => {
					if (Option.isNone(key)) return Option.none();
					return Result.getOrElse(
						Result.try(() => {
							const bytes = Buffer.from(envelope, 'base64');
							const decipher = createDecipheriv(
								'aes-256-gcm',
								Redacted.value(key.value),
								bytes.subarray(0, 12)
							).setAAD(aad(owner, name));
							decipher.setAuthTag(bytes.subarray(12, 28));
							return Option.some(
								Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
									'utf8'
								)
							);
						}),
						() => Option.none()
					); // copied envelopes cannot open under another owner/name
				};
				const rows = Option.isNone(key)
					? []
					: yield* db.rows(stored.annotate({ identifier: 'sys_config' }), {
							text: 'SELECT key, value FROM sys_config WHERE key LIKE $1',
							params: [`${prefix('workspace')}%`]
						});
				for (const row of rows) {
					const name = row.key.slice(prefix('workspace').length);
					const value = open('workspace', name, row.value);
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
