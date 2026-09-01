import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { eq } from 'drizzle-orm';
import {
	describeEnvironment,
	type EnvironmentVariableView
} from '#lib/authoring/environment-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, dbNow, executeBuilt } from '#lib/runtime/persistence.js';
import * as Workspace from '#lib/runtime/workspace.js';
import {
	SecretCipher,
	bind,
	type SecretKeyUnavailable,
	type SecretUnreadable
} from '@norbital-ai/std/secret';

/**
 * The binding for a `bolt_secrets` row. The table has one row per name, so the name is its identity.
 *
 * Stated here, beside the vault that owns the table, rather than in the shared cipher: the cipher
 * knows how to authenticate a row against an identity, and which columns *are* the identity is a
 * fact about this table. Naming the table in the binding is what keeps a workspace envelope from
 * opening as a personal one, or as one of Colony's host-side browser sessions.
 */
const workspaceBinding = (name: string): string => bind('bolt_secrets', name);
const { bolt_secrets: boltSecrets } = SYSTEM_MODEL_TABLES;

/**
 * Carries the one failure `SecretCipher.encrypt` reports as a bare `Error` into this vault's own
 * declared channel.
 *
 * `encrypt` refuses a missing or unusable key as `SecretKeyUnavailable`, which `write` already
 * declares and a caller already knows what to do about. What is left in its `| Error` half is the
 * host's WebCrypto failing *mid-seal* — a different thing to tell somebody, and one nobody fixes by
 * setting a key that is already set. It is an infrastructure failure of exactly the kind
 * `FacilityError` exists to carry, so it is mapped rather than widened away: the reason travels
 * verbatim in `message`, and `write` keeps the union it promises.
 */
const sealFailed = (operation: string, cause: Error): Database.FacilityError =>
	new Database.FacilityError({
		operation,
		code: 'secret_seal_failed',
		message: `${operation} failed while sealing the value: ${cause.message === '' ? String(cause) : cause.message}`,
		retryable: false,
		outcome: 'unknown'
	});

/**
 * The Secrets vault: the values behind a workspace's `+env.ts` declaration.
 *
 * Three rules shape this service, and each is enforced here rather than left to callers:
 *
 * 1. **Server-side only.** Nothing in this module is reachable from the client bundle. `read` has no
 *    command surface — a browser cannot ask for a value at all, only for the *shape* of the
 *    declaration and whether each entry is set.
 * 2. **Always optional.** `read` returns `string | null`. There is no variant that throws on a
 *    missing value, because a capability that needs one can say which name is missing far better
 *    than this layer can.
 * 3. **Declared names only.** A read or write of a name `+env.ts` does not declare fails. The vault
 *    is not a key-value store that anything may scribble in; it holds exactly what the workspace
 *    asked for, so an unset value is always a value someone has yet to supply rather than a typo
 *    nobody will ever notice.
 * 4. **Encrypted at rest, or not stored at all.** Every `{ env: 'NAME' }` credential an integration or
 *    channel declares resolves through `read` below, so this table is where a WhatsApp token, an API
 *    key and every other third-party credential a workspace holds actually live. `value` is a `v1`
 *    AES-256-GCM envelope from `secret-cipher.ts`, sealed under a host-held key the tenant database
 *    never contains and bound to the row's name. `write` refuses when no key is configured rather
 *    than falling back to plaintext — the caller cannot tell the two apart, so the silent option is
 *    the one that leaves credentials readable to anyone holding a backup.
 *
 * Who may write is unchanged: `manage secrets` still opens this vault, and encryption is a storage
 * property, not an authorization one. It defends the copies of the row that never pass through an
 * authorization check at all — backups, replicas, a snapshot on somebody's laptop.
 */

class SecretNotDeclared extends Schema.TaggedError<SecretNotDeclared>()(
	'Bolt.Secrets.NotDeclared',
	{ name: Schema.NonEmptyString }
) {
	readonly message = `No environment variable named ${this.name} is declared in +env.ts.`;
	readonly retryable = false;
	readonly outcome = 'known' as const;
}

/** What a client may know about one entry: its declaration, plus whether a value exists. */
type SecretStatus = EnvironmentVariableView & {
	readonly configured: boolean;
	readonly updatedAt?: string;
};

export type Interface = Readonly<{
	/**
	 * Reads a declared value, or `null` when the vault has none.
	 *
	 * Server-side callers only. A caller that cannot proceed without the value refuses at its own
	 * boundary, naming the variable — this layer does not know what the value is for.
	 */
	readonly read: (
		effectId: EffectId,
		name: string
	) => Effect.Effect<
		string | null,
		SecretNotDeclared | Database.FacilityError | SecretKeyUnavailable | SecretUnreadable
	>;
	/**
	 * Every declared entry with whether it is set. Safe to send to a browser; carries no values.
	 *
	 * Needs no key and decrypts nothing — it reads `name` and `updated_at` only — so the settings
	 * screen still works on a host whose key is missing, which is precisely when somebody needs to be
	 * able to look.
	 */
	readonly status: (
		effectId: EffectId
	) => Effect.Effect<ReadonlyArray<SecretStatus>, Database.FacilityError>;
	/**
	 * Stores a value. An empty string clears the entry rather than storing emptiness.
	 *
	 * Fails with `SecretKeyUnavailable` when the host has configured no encryption key, and stores
	 * nothing in that case — there is no branch here that writes a value in the clear.
	 */
	readonly write: (
		effectId: EffectId,
		name: string,
		value: string,
		updatedBy: string
	) => Effect.Effect<void, SecretNotDeclared | Database.FacilityError | SecretKeyUnavailable>;
}>;

const Service = Context.Service<Interface>('@norbital-ai/bolt/Secrets');

const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const workspace = yield* Workspace.Service;
		const cipher = yield* SecretCipher.Service;

		const declared = (): ReadonlyArray<EnvironmentVariableView> =>
			describeEnvironment(workspace.definition.environment);

		const requireDeclared = (
			name: string
		): Effect.Effect<EnvironmentVariableView, SecretNotDeclared> => {
			const entry = declared().find((variable) => variable.name === name);
			return entry === undefined
				? Effect.fail(new SecretNotDeclared({ name }))
				: Effect.succeed(entry);
		};

		const read: Interface['read'] = Effect.fn('Secrets.read')(function* (
			effectId: EffectId,
			name: string
		) {
			const variable = yield* requireDeclared(name);
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ value: boltSecrets.value })
					.from(boltSecrets)
					.where(eq(boltSecrets.name, name))
					.limit(1)
			);
			const [row] = result.rows;
			const stored =
				row !== null && typeof row === 'object' && !Array.isArray(row)
					? Reflect.get(row, 'value')
					: undefined;
			// A stored row that will not open is a failure, not a fall-through to the default: silently
			// answering with the declared default would start an integration against the wrong endpoint,
			// or — worse for a `secret: true` name, which cannot carry a default — read as "not set" and
			// send somebody to re-enter a credential without ever saying the stored one was unreadable.
			if (typeof stored === 'string' && stored !== '')
				return yield* cipher.decrypt(name, workspaceBinding(name), stored);
			// A declared default stands in for an unset value, and `defineEnvironment` refuses a default
			// on anything marked secret — so this can never hand back a credential from source.
			return variable.default ?? null;
		});

		const status: Interface['status'] = Effect.fn('Secrets.status')(function* (effectId: EffectId) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ name: boltSecrets.name, updated_at: boltSecrets.updated_at })
					.from(boltSecrets)
			);
			const stored = new Map<string, string | undefined>();
			for (const row of result.rows) {
				if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
				const name = Reflect.get(row, 'name');
				const updatedAt = Reflect.get(row, 'updated_at');
				if (typeof name === 'string')
					stored.set(name, typeof updatedAt === 'string' ? updatedAt : undefined);
			}
			return declared().map((variable) => {
				const updatedAt = stored.get(variable.name);
				return {
					...variable,
					configured: stored.has(variable.name),
					...(updatedAt === undefined ? {} : { updatedAt })
				};
			});
		});

		const write: Interface['write'] = Effect.fn('Secrets.write')(function* (
			effectId: EffectId,
			name: string,
			value: string,
			updatedBy: string
		) {
			yield* requireDeclared(name);
			if (value === '') {
				// Clearing is deleting. Storing an empty string would make `read` return `''`, which is a
				// value, and every downstream null check would pass on a secret that is not there.
				yield* executeBuilt(
					effectId,
					database,
					composer.delete(boltSecrets).where(eq(boltSecrets.name, name))
				);
				return;
			}
			// Sealed before the statement is built, so a missing key refuses *ahead of* the write. There is
			// no ordering here in which a plaintext credential reaches the table.
			const operation = `storing the secret ${name}`;
			const sealed = yield* cipher
				.encrypt(operation, workspaceBinding(name), value)
				.pipe(
					Effect.mapError((cause) =>
						cause instanceof SecretCipher.SecretKeyUnavailable
							? cause
							: sealFailed(operation, cause)
					)
				);
			yield* executeBuilt(
				effectId,
				database,
				composer
					.insert(boltSecrets)
					.values({ tenant_id: '', name, value: sealed, updated_by: updatedBy })
					.onConflictDoUpdate({
						target: [boltSecrets.tenant_id, boltSecrets.name],
						set: { value: sealed, updated_by: updatedBy, updated_at: dbNow() }
					})
			);
		});

		return { read, status, write };
	})
);

export const Secrets = { Service, layer, SecretNotDeclared };
