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

export const SYSTEM_COLLECTIONS: ReadonlyArray<CollectionDefinition<Readonly<Record<string, FieldDefinition>>>> = Object.freeze([
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
	grants: SYSTEM_COLLECTIONS.map(({ name }) => ({ collection: name, action: 'read' }))
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
