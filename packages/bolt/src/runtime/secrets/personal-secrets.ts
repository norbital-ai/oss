import { Context, Effect, Layer, Option, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import {
	SecretCipher,
	bind,
	type SecretKeyUnavailable,
	type SecretUnreadable
} from '@norbital-ai/std/secret';

/**
 * The binding for a `bolt_personal_secrets` row: the whole primary key, so no row can stand in for
 * another.
 *
 * Stated here rather than in the shared cipher for the same reason as the workspace one — the table
 * that owns the row owns the definition of what identifies it. The leading table name is what makes
 * an envelope non-transferable *between* stores as well as between rows: Colony's browser sessions
 * seal `(colony_browser_sessions, tenant, profile, name)` under the same host key, and neither side
 * can open the other's.
 */
const personalBinding = (tenantId: string, userId: string, name: string): string =>
	bind('bolt_personal_secrets', tenantId, userId, name);

/**
 * Personal secrets: the credentials that belong to a *person*, not to the workspace.
 *
 * A signed-in browser session for LinkedIn, a personal API token, a cookie jar somebody obtained by
 * logging in themselves — these let a capability act as that individual, and they are exactly the
 * kind of thing that must not be workspace configuration. `Secrets` (the `bolt_secrets` vault) holds
 * workspace configuration: one value per name for the whole tenant, read and written by anyone
 * carrying `manage secrets`. Bolting a `user_id` column onto that table would have kept that access
 * rule, and an admin would have been able to read somebody's LinkedIn session by virtue of being an
 * admin. That is the whole reason this is a separate table with a separate service.
 *
 * The rule, and the shape that enforces it:
 *
 * 1. **The owner is the only reader and the only writer.** Not "the owner, plus an admin". There is
 *    no operation on this service that reads or writes another person's row, so there is nothing for
 *    an authorization check to be too lenient about.
 * 2. **The owner is `Identity.CurrentSubject` and nothing else.** No method takes a user id. The
 *    `user_id` in every WHERE clause below comes from the subject `dispatchInvocation` provided
 *    *after* it authenticated a credential, so a payload cannot name one — that is precisely the hole
 *    `secrets.write` once had, where `{"subject":{"roles":["admin"]}}` in a request body was believed.
 *    A caller cannot pass the wrong user id because a caller cannot pass a user id.
 * 3. **Work with nobody behind it is refused, not served.** A scheduled task has no person, so it has
 *    no personal secrets — and `NoPersonalSubject` says so. An empty result would read as "this user
 *    has not set one up yet" and send somebody to re-enter a credential that is already stored.
 * 4. **Server-side only for values.** `read` has no command surface, for the same reason `secrets.read`
 *    does not exist: one command is all it takes to put every stored credential a fetch away from a
 *    browser.
 * 5. **Encrypted at rest, or not stored at all.** Every rule above is an *access* rule, and an access
 *    rule is enforced by the process that reads the row. A backup, a replica, a support engineer with
 *    a psql prompt, a snapshot on a laptop — none of those go through `owner()`. `value` is therefore
 *    a `v1` AES-256-GCM envelope from `secret-cipher.ts`, sealed under a key the host holds and the
 *    tenant database never sees, and bound to `(tenant, user, name)` so an envelope cannot be moved
 *    into somebody else's row. `write` refuses when there is no key rather than falling back to
 *    plaintext: a caller cannot see which of the two happened, so the quiet option is the one that
 *    leaves a live LinkedIn session sitting in a text column while everybody believes otherwise.
 *
 * Names are free-form, unlike the vault's `+env.ts`-declared ones. A personal credential is not
 * something the workspace can declare in advance — the author does not know which sites a given
 * person will sign in to — so there is no declaration to check a name against, and inventing one
 * would only make the check a lie. The command boundary requires a non-empty name; beyond that the
 * key space belongs to the user it is partitioned by.
 */

/** The typed refusal for an invocation with no person behind it: a task, an activation, a health probe. */
class NoPersonalSubject extends Schema.TaggedError<NoPersonalSubject>()(
	'Bolt.PersonalSecrets.NoSubject',
	{ operation: Schema.NonEmptyString }
) {
	readonly message = `Personal secrets belong to a person, and this invocation has none, so ${this.operation} is refused rather than answered for nobody.`;
	readonly retryable = false;
	readonly outcome = 'known' as const;
}

/** What the owner may know about one of their own entries: its name and whether a value is stored — never the value. */
type PersonalSecretStatus = Readonly<{
	readonly name: string;
	readonly configured: boolean;
	readonly updatedAt?: string;
}>;

export type Interface = Readonly<{
	/**
	 * Reads the calling person's own value, or `null` when they have none.
	 *
	 * Server-side callers only — there is no `personal-secrets.read` command. The value returned is
	 * always the caller's; there is no argument that could make it somebody else's.
	 */
	readonly read: (
		effectId: EffectId,
		name: string
	) => Effect.Effect<
		string | null,
		NoPersonalSubject | Database.FacilityError | SecretKeyUnavailable | SecretUnreadable
	>;
	/**
	 * Stores the calling person's value. An empty string clears the entry rather than storing emptiness.
	 *
	 * Fails with `SecretKeyUnavailable` when the host has configured no encryption key, and stores
	 * nothing in that case — there is no branch here that writes a value in the clear.
	 */
	readonly write: (
		effectId: EffectId,
		name: string,
		value: string
	) => Effect.Effect<void, NoPersonalSubject | Database.FacilityError | SecretKeyUnavailable>;
	/** The calling person's own entries and whether each is set. Safe to send to a browser; carries no values. */
	readonly status: (
		effectId: EffectId
	) => Effect.Effect<
		ReadonlyArray<PersonalSecretStatus>,
		NoPersonalSubject | Database.FacilityError
	>;
	/** Deletes the calling person's entry. Absent is the same as deleted, so this is idempotent. */
	readonly forget: (
		effectId: EffectId,
		name: string
	) => Effect.Effect<void, NoPersonalSubject | Database.FacilityError>;
}>;

const Service = Context.Service<Interface>('@norbital-ai/bolt/PersonalSecrets');

/** Reads the loosely-typed values a SQL row hands back without scattering guards through each projection. */
const rowText = (row: unknown, field: string): string | undefined => {
	const value =
		row === null || typeof row !== 'object' || Array.isArray(row)
			? undefined
			: Reflect.get(row, field);
	return typeof value === 'string' ? value : undefined;
};

const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const cipher = yield* SecretCipher.Service;

		/**
		 * Whose row this is, and the only place any method may learn it.
		 *
		 * `Identity.currentSubject` is `Effect.serviceOption(Identity.CurrentSubject)`, and
		 * `CurrentSubject` is provided by `dispatchInvocation` from the subject `authenticate` returned —
		 * never from a request body, which `MINTED_IDENTITY` overwrote before any case could read it. So
		 * the pair below is unspoofable in the only sense that matters: there is no route from anything a
		 * caller controls to these two values.
		 */
		const owner = Effect.fn('PersonalSecrets.owner')(function* (operation: string) {
			const subject = yield* Identity.currentSubject;
			if (Option.isNone(subject)) return yield* new NoPersonalSubject({ operation });
			return { tenantId: subject.value.tenantId, userId: subject.value.userId };
		});

		const read: Interface['read'] = Effect.fn('PersonalSecrets.read')(function* (
			effectId: EffectId,
			name: string
		) {
			const { tenantId, userId } = yield* owner('read');
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'select value from bolt_personal_secrets where tenant_id = $1 and user_id = $2 and name = $3',
				parameters: [tenantId, userId, name]
			});
			const stored = rowText(result.rows[0], 'value');
			// Unlike the workspace vault there is no declared default to fall back to: a default for a
			// personal credential would be a shared one, which is the thing this table exists to avoid.
			if (stored === undefined || stored === '') return null;
			// A row that is present but will not open is *not* answered as `null`. `null` means "you have
			// not set this up", which sends the owner to a set-up flow; an unreadable row means "what is
			// stored cannot be recovered", which is a different thing to do about it and a different thing
			// to tell somebody.
			return yield* cipher.decrypt(name, personalBinding(tenantId, userId, name), stored);
		});

		const write: Interface['write'] = Effect.fn('PersonalSecrets.write')(function* (
			effectId: EffectId,
			name: string,
			value: string
		) {
			const { tenantId, userId } = yield* owner('write');
			if (value === '') {
				// Clearing is deleting, as in the workspace vault. Storing an empty string would make `read`
				// return `''`, which is a value, and every downstream null check would pass on a credential
				// that is not there.
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'delete from bolt_personal_secrets where tenant_id = $1 and user_id = $2 and name = $3',
					parameters: [tenantId, userId, name]
				});
				return;
			}
			// Sealed before the statement is even built, so a missing key refuses *ahead of* the write
			// rather than after it. There is no ordering here in which a plaintext row reaches the table.
			const sealed = yield* cipher.encrypt(
				`storing the personal secret ${name}`,
				personalBinding(tenantId, userId, name),
				value
			);
			yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `insert into bolt_personal_secrets (tenant_id, user_id, name, value) values ($1, $2, $3, $4)
				      on conflict (tenant_id, user_id, name) do update set value = excluded.value, updated_at = now()`,
				parameters: [tenantId, userId, name, sealed]
			});
		});

		const status: Interface['status'] = Effect.fn('PersonalSecrets.status')(function* (
			effectId: EffectId
		) {
			const { tenantId, userId } = yield* owner('status');
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				// `configured` is computed in SQL rather than assumed from the row existing: `write` deletes
				// on clear, so a row should always carry a value, and a row that does not is a fault worth
				// reporting as "not set" instead of hiding behind its own presence. The value itself never
				// leaves the database.
				//
				// It is a `length()` on the ciphertext, so this needs no key and does no decryption: the
				// owner can still see which of their entries are set on a host whose key is missing or has
				// been rotated, which is exactly when they most need to be told something is wrong.
				sql: `select name, length(value) > 0 as configured, updated_at
				      from bolt_personal_secrets where tenant_id = $1 and user_id = $2 order by name`,
				parameters: [tenantId, userId]
			});
			return result.rows.flatMap((row) => {
				const name = rowText(row, 'name');
				if (name === undefined || name === '') return [];
				const updatedAt = rowText(row, 'updated_at');
				const configured =
					row !== null && typeof row === 'object' && !Array.isArray(row)
						? Reflect.get(row, 'configured')
						: undefined;
				return [
					{
						name,
						configured: configured === true,
						...(updatedAt === undefined ? {} : { updatedAt })
					}
				];
			});
		});

		const forget: Interface['forget'] = Effect.fn('PersonalSecrets.forget')(function* (
			effectId: EffectId,
			name: string
		) {
			const { tenantId, userId } = yield* owner('forget');
			yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'delete from bolt_personal_secrets where tenant_id = $1 and user_id = $2 and name = $3',
				parameters: [tenantId, userId, name]
			});
		});

		return { read, write, status, forget };
	})
);

export const PersonalSecrets = { Service, layer, NoPersonalSubject };
