import { collection, field, type CollectionDefinition, type FieldDefinition, type PolicyDeclaration } from '../../authoring/workspace-schema.js';

/**
 * Collections the runtime owns and authored workspace code reads.
 *
 * Approval state is not private runtime bookkeeping: a workspace decides what "live" means by
 * filtering on `norbital_approval_id`, and its reports read `approval_request` directly for status,
 * timing, and which rows a request holds. Declaring them here — rather than as hand-written DDL —
 * keeps one source for the schema plan, the where compiler's column list, and lookup.
 *
 * They stay here rather than becoming `src/collections/approval_request/+model.ts` in each workspace,
 * and the reason is that they are not the workspace's to declare. `Approvals` writes these rows in
 * every workspace, including one that authors no collections at all, so a template that omitted the
 * model — or renamed a column in it — would boot a runtime whose only writer has nowhere to write.
 * Twenty-odd templates each holding their own copy of Bolt's table is twenty places for that shape to
 * drift from the service that owns it.
 *
 * What keeps the shape honest is `verify`: it reads `information_schema` and compares every column of
 * `withSystemCollections(definition)` against the live table, so a database whose `approval_request`
 * predates a change here is named column by column and `migrate` refuses to report success. The cost
 * of staying runtime-owned is that `bolt migrate` writes no `ALTER` for them — the plan's
 * `create table if not exists` provisions a new database and cannot evolve an old one — so changing a
 * field here fails an existing workspace loudly rather than migrating it. That is a live limitation,
 * not a covered case.
 */

/** One open or closed approval flow over a collection mutation. */
const approvalRequest = collection({
	name: 'approval_request',
	fields: {
		collection_name: field.string({ required: true, indexed: true }),
		record_id: field.string({ required: true, indexed: true }),
		action: field.string({ required: true }),
		status: field.string({ required: true, indexed: true }),
		steps: field.json({ required: true }),
		locked_record_refs: field.json({ required: true }),
		closed_at: field.datetime(),
		closed_by: field.string()
	},
	history: false
});

/** Links an approval request to the user who raised it. */
const requestor = collection({
	name: 'requestor',
	fields: {
		approval_request_id: field.string({ required: true, indexed: true }),
		user_id: field.string({ required: true, indexed: true })
	},
	history: false
});

/**
 * Identity, declared as collections rather than as DDL beside them.
 *
 * These four *are* Better Auth's tables. There is no second `user` shadowing an auth table and no
 * hand-written `create table` for them anywhere: they are ordinary runtime-owned collections, so the
 * schema plan creates them the way it creates `approval_request`, `verify` checks their columns like
 * any other, and a workspace relates to `user` with the same `norbital_id` every collection is keyed
 * by. `auth-tables.ts` maps Better Auth's field names onto these columns, which is all the library
 * requires of a schema.
 *
 * They are the runtime's and not the workspace's for the reason the note above gives: identity
 * exists in every workspace, including one that authors no collections at all, so a template that
 * omitted the model — or renamed a column in it — would boot a runtime whose only writer has nowhere
 * to write.
 *
 * The prefix on the table names is deliberate. `user`, `session` and `account` are names a tenant's
 * own workspace is entitled to use, and a workspace with a `user` collection would otherwise share a
 * table with the auth system and corrupt both.
 */
const authUser = collection({
	name: 'bolt_auth_user',
	fields: {
		name: field.string({ required: true }),
		/**
		 * One row per address, and the index is unique for two reasons that meet here.
		 *
		 * Better Auth already assumes it — it looks a person up by email and expects one answer — and
		 * admitting a workspace's first administrator depends on it: that write is an upsert on the
		 * address, made before the person exists, so `on conflict ("email")` needs something to
		 * conflict against. Without it the statement does not degrade, it fails, and the founder is
		 * left with a workspace they can sign into and cannot read. Nulls do not collide in a Postgres
		 * unique index, so the provisioner's addressless service row is unaffected.
		 */
		email: field.string({ indexed: true, unique: true }),
		emailVerified: field.boolean({ required: true, sqlDefault: 'false' }),
		image: field.string(),
		/**
		 * What kind of subject this is. A host provisioner is not a person, and the design this
		 * replaced gave it one: a row called `admin-1` carrying a real employee's address.
		 */
		kind: field.string({ required: true, sqlDefault: "'person'" }),
		/** The workspace this subject belongs to — Bolt's concept, not Better Auth's. */
		tenantId: field.string({ indexed: true }),
		roles: field.json({ required: true, sqlDefault: "'[]'::jsonb" }),
		teams: field.json({ required: true, sqlDefault: "'[]'::jsonb" })
	},
	history: false
});

const authSession = collection({
	name: 'bolt_auth_session',
	fields: {
		expiresAt: field.datetime({ required: true }),
		token: field.string({ required: true, indexed: true }),
		ipAddress: field.string(),
		userAgent: field.string(),
		userId: field.uuid({ required: true, indexed: true })
	},
	history: false
});

const authAccount = collection({
	name: 'bolt_auth_account',
	fields: {
		accountId: field.string({ required: true }),
		providerId: field.string({ required: true }),
		userId: field.uuid({ required: true, indexed: true }),
		accessToken: field.string(),
		refreshToken: field.string(),
		idToken: field.string(),
		accessTokenExpiresAt: field.datetime(),
		refreshTokenExpiresAt: field.datetime(),
		scope: field.string(),
		password: field.string()
	},
	history: false
});

const authVerification = collection({
	name: 'bolt_auth_verification',
	fields: {
		identifier: field.string({ required: true, indexed: true }),
		value: field.string({ required: true }),
		expiresAt: field.datetime({ required: true })
	},
	history: false
});

/** Where bolt keeps the secret that signs its sessions, generated on first use. */
const authConfig = collection({
	name: 'bolt_auth_config',
	fields: {
		key: field.string({ required: true, indexed: true }),
		value: field.string({ required: true })
	},
	history: false
});

export const IDENTITY_COLLECTIONS: ReadonlyArray<CollectionDefinition<Readonly<Record<string, FieldDefinition>>>> = Object.freeze([
	authUser,
	authSession,
	authAccount,
	authVerification,
	authConfig
]);

export const SYSTEM_COLLECTIONS: ReadonlyArray<CollectionDefinition<Readonly<Record<string, FieldDefinition>>>> = Object.freeze([
	...IDENTITY_COLLECTIONS,
	approvalRequest,
	requestor
]);

export const SYSTEM_COLLECTION_NAMES: ReadonlySet<string> = new Set(SYSTEM_COLLECTIONS.map(({ name }) => name));

/**
 * Reading runtime state is allowed for any authenticated subject; writing never is, because the
 * owning service is the only writer. An authored `deny` policy still wins — this is an ordinary
 * declaration evaluated with the rest, not a bypass.
 */
export const SYSTEM_READ_POLICY: PolicyDeclaration = Object.freeze<PolicyDeclaration>({
	name: 'bolt.system-collections',
	description: 'Read access to runtime-owned collections that authored queries and reports depend on.',
	effect: 'allow',
	/**
	 * Identity is deliberately not here.
	 *
	 * This grant exists so an authored query can read the runtime's own bookkeeping — approval state
	 * a report filters on. `bolt_auth_user` is not that: it holds every person in the workspace with
	 * their roles, teams and address, and granting read on it to any authenticated subject would put
	 * the whole membership behind one signed-in session and replicate it into every browser the sync
	 * engine serves. Identity is read through `Identity`, which answers about the caller, and through
	 * `workspaceAccess`, which is authorised on its own terms.
	 */
	grants: SYSTEM_COLLECTIONS.filter(
		({ name }) => !IDENTITY_COLLECTIONS.some((identity) => identity.name === name)
	).map(({ name }) => ({ collection: name, action: 'read' }))
});

/** Merges runtime-owned collections into an authored definition without letting either shadow the other. */
export const withSystemCollections = <T extends { readonly collections: ReadonlyArray<CollectionDefinition<Readonly<Record<string, FieldDefinition>>>>; readonly policies: ReadonlyArray<PolicyDeclaration> }>(
	definition: T
): T => {
	const authored = new Set(definition.collections.map(({ name }) => name));
	const missing = SYSTEM_COLLECTIONS.filter(({ name }) => !authored.has(name));
	if (missing.length === 0 && definition.policies.some(({ name }) => name === SYSTEM_READ_POLICY.name)) return definition;
	return {
		...definition,
		collections: [...definition.collections, ...missing],
		policies: definition.policies.some(({ name }) => name === SYSTEM_READ_POLICY.name)
			? definition.policies
			: [...definition.policies, SYSTEM_READ_POLICY]
	};
};
