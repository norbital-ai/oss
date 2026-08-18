import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { describeEnvironment, type EnvironmentVariableView } from '../../authoring/environment-schema.js';
import { Database } from '../facilities/database.js';
import { Workspace } from '../workspace.js';
import { SecretCipher, bind, type SecretKeyUnavailable, type SecretUnreadable } from '@norbital-ai/std/secret';

/**
 * The binding for a `bolt_secrets` row. The table has one row per name, so the name is its identity.
 *
 * Stated here, beside the vault that owns the table, rather than in the shared cipher: the cipher
 * knows how to authenticate a row against an identity, and which columns *are* the identity is a
 * fact about this table. Naming the table in the binding is what keeps a workspace envelope from
 * opening as a personal one, or as one of Colony's host-side browser sessions.
 */
const workspaceBinding = (name: string): string => bind('bolt_secrets', name);

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

export class SecretNotDeclared extends Schema.TaggedError<SecretNotDeclared>()(
	'Bolt.Secrets.NotDeclared',
	{ name: Schema.NonEmptyString }
) {
	readonly message = `No environment variable named ${this.name} is declared in +env.ts.`;
	readonly retryable = false;
	readonly outcome = 'known' as const;
}

/** What a client may know about one entry: its declaration, plus whether a value exists. */
export type SecretStatus = EnvironmentVariableView & {
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
	readonly read: (effectId: EffectId, name: string) => Effect.Effect<
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
	readonly status: (effectId: EffectId) => Effect.Effect<ReadonlyArray<SecretStatus>, Database.FacilityError>;
	/**
	 * Stores a value. An empty string clears the entry rather than storing emptiness.
	 *
	 * Fails with `SecretKeyUnavailable` when the host has configured no encryption key, and stores
	 * nothing in that case — there is no branch here that writes a value in the clear.
	 */
	readonly write: (effectId: EffectId, name: string, value: string, updatedBy: string) => Effect.Effect<
		void,
		SecretNotDeclared | Database.FacilityError | SecretKeyUnavailable
	>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Secrets');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const workspace = yield* Workspace.Service;
		const cipher = yield* SecretCipher.Service;

		const declared = (): ReadonlyArray<EnvironmentVariableView> =>
			describeEnvironment(workspace.definition.environment);

		const requireDeclared = (name: string): Effect.Effect<EnvironmentVariableView, SecretNotDeclared> => {
			const entry = declared().find((variable) => variable.name === name);
			return entry === undefined ? Effect.fail(new SecretNotDeclared({ name })) : Effect.succeed(entry);
		};

		const storedValue = (effectId: EffectId, name: string) =>
			database.execute(effectId, {
				_tag: 'Query',
				sql: 'select value from bolt_secrets where name = $1',
				parameters: [name]
			});

		const read: Interface['read'] = Effect.fn('Secrets.read')(function* (effectId: EffectId, name: string) {
			const variable = yield* requireDeclared(name);
			const result = yield* storedValue(effectId, name);
			const [row] = result.rows;
			const stored = row !== null && typeof row === 'object' && !Array.isArray(row) ? Reflect.get(row, 'value') : undefined;
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
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'select name, updated_at from bolt_secrets',
				parameters: []
			});
			const stored = new Map<string, string | undefined>();
			for (const row of result.rows) {
				if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
				const name = Reflect.get(row, 'name');
				const updatedAt = Reflect.get(row, 'updated_at');
				if (typeof name === 'string') stored.set(name, typeof updatedAt === 'string' ? updatedAt : undefined);
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
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'delete from bolt_secrets where name = $1',
					parameters: [name]
				});
				return;
			}
			// Sealed before the statement is built, so a missing key refuses *ahead of* the write. There is
			// no ordering here in which a plaintext credential reaches the table.
			const sealed = yield* cipher.encrypt(`storing the secret ${name}`, workspaceBinding(name), value);
			yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `insert into bolt_secrets (tenant_id, name, value, updated_by) values ('', $1, $2, $3)
				      on conflict (tenant_id, name) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
				parameters: [name, sealed, updatedBy]
			});
		});

		return { read, status, write };
	})
);

export const Secrets = { Service, layer, SecretNotDeclared };
