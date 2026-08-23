import { Record as EffectRecord } from 'effect';
import { compileModel } from '#lib/authoring/model-introspection.js';
import { SYSTEM_COLLECTION_MODELS } from '#lib/authoring/system-models.js';
import {
	collection,
	type CollectionDefinition,
	type FieldDefinition,
	type PolicyDeclaration
} from '#lib/authoring/workspace-schema.js';
import { COLONY_SYSTEM_POLICY } from '#lib/runtime/access/system-principal.js';

/**
 * Platform models enter through the same model-to-collection compiler as tenant-authored models.
 *
 * The empty base contributes only the collection name. Drizzle fields, indexes, history, description,
 * and every other model fact come from the canonical `defineModel` declaration.
 */
const collections = Object.freeze(
	EffectRecord.map(SYSTEM_COLLECTION_MODELS, (declaration, name) =>
		compileModel(collection({ name, fields: {} }), declaration)
	)
);

/**
 * The collections authentication itself reads, and therefore the ones a host must create before it
 * can migrate anything else. `team` is among them because resolving a subject now joins it: a
 * host that created the auth tables and not this one would authenticate nobody.
 */
export const IDENTITY_COLLECTIONS: ReadonlyArray<
	CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
> = Object.freeze([
	collections.user,
	collections.session,
	collections.account,
	collections.verification,
	collections.auth_config,
	collections.team
]);

export const SYSTEM_COLLECTIONS: ReadonlyArray<
	CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
> = Object.freeze([
	...IDENTITY_COLLECTIONS,
	collections.approval_request,
	collections.requestor,
	collections.chat_session,
	collections.chat_message,
	collections.bolt_notifications
]);

const SYSTEM_COLLECTIONS_BY_NAME = new Map(
	SYSTEM_COLLECTIONS.map((definition) => [definition.name, definition] as const)
);

/**
 * The approval requests this subject raised.
 *
 * The `requestor` join table is the only record of who that was: `approval_request` carries the
 * collection, the record, the action and the status, and no requestor column at all, so "is this
 * mine" cannot be answered from the row itself. `Approvals.request` writes exactly one `requestor`
 * row per request, in the same block that projects the `approval_request` row.
 *
 * `${requestor.id}` is **not** interpolated by JavaScript here — these are single-quoted
 * strings, so the literal token reaches the policy compiler, which binds `subject.userId` as a
 * parameter. `party` rather than `requestor` as the alias only because the table and the token
 * prefix share a spelling and a reader should not have to work out which is which.
 */
const RAISED_BY_SUBJECT =
	'select party."approval_request_id" from requestor party ' +
	'where party."user_id" = ${requestor.id}';

/**
 * The name of this subject's one team, folded — reached by a join, because no token names it.
 *
 * `AccessControl.subjectValue` resolves exactly three paths — `requestor.id`,
 * `requestor.tenantId`, `requestor.email` — so a team is something the predicate has to go and look
 * up. `user.team_id` is one team, nullable, and a subject nobody has placed yields no row:
 * the scalar subquery is then `null`, `lower(...) = null` is `null`, and the approver leg below
 * matches nothing. Absence narrows, which is the only safe direction for it to go.
 *
 * The subject's own team and not the whole of `teamPath`. `Approvals.decide` matches
 * `step.approvers` against `teamPath[0]` — the subject's own team — so anything wider here would
 * show a member approvals they are not eligible to decide, and `teamPath` runs *downward* through
 * the hierarchy unconditionally, which is the opposite of "their higher ups".
 */
const SUBJECT_TEAM_NAME =
	'select lower(subject_team."name") from "user" subject_user ' +
	'join "team" subject_team on subject_team."id" = subject_user."team_id" ' +
	'where subject_user."id"::text = ${requestor.id}';

/**
 * The approval requests this subject's team is named as an approver of — the "higher ups" leg.
 *
 * **Read from `bolt_approvals`, not from `approval_request.steps`, and that is not a preference.**
 * `steps` is a *cursor*, not a configuration: `Approvals.projectRequest` writes
 * `[{ step: <n> }]` while a request is pending and `[]` once it closes, and no approver name has
 * ever been in that column. A containment test over it would compile, run, and match nothing —
 * silently withholding from approvers the very requests they exist to decide.
 *
 * The approver names live in the durable state `Approvals.request` embeds at request time, under
 * `state.operation.approval` — the whole `ApprovalConfiguration` the subject's own grant carried,
 * copied into the row so that a later release changing the grant cannot restate an in-flight
 * request. `Approvals.decide` resolves the same path (`approvalConfigurations.resolve`) before it
 * decides eligibility, so read scope and decide eligibility are two readings of one value.
 *
 * `jsonb_typeof(...) = 'array'` guards both unnests rather than trusting the shape: a legacy or
 * hand-written state whose `steps` is not an array would otherwise raise
 * `cannot extract elements from an object` from inside a permission check, which turns a narrowing
 * into an outage. Folded comparison, because every other comparison of a team name in this runtime
 * is folded — `TEAM_LOOKUP_SQL`, `policiesHeldByTeam`, `Approvals.decide` — and two spellings must
 * not mean two teams.
 */
const APPROVED_BY_SUBJECT_TEAM =
	'select approval.request_id from bolt_approvals approval ' +
	'cross join lateral jsonb_array_elements(' +
	"case when jsonb_typeof(approval.state #> '{operation,approval,steps}') = 'array' " +
	"then approval.state #> '{operation,approval,steps}' else '[]'::jsonb end" +
	') as approval_step(step_value) ' +
	'cross join lateral jsonb_array_elements_text(' +
	"case when jsonb_typeof(step_value->'approvers') = 'array' " +
	"then step_value->'approvers' else '[]'::jsonb end" +
	') as approver(team_name) ' +
	'where lower(team_name) = (' +
	SUBJECT_TEAM_NAME +
	')';

/**
 * Requests held by a collection-level `approvalLock` have no authored step configuration. At
 * request time the approval service snapshots the teams whose declared policies grant the generic
 * Approvals capability; this leg gives those same teams inbox discovery without widening the row to
 * every authenticated member.
 */
const GENERICALLY_APPROVED_BY_SUBJECT_TEAM =
	'select approval.request_id from bolt_approvals approval ' +
	'cross join lateral jsonb_array_elements_text(' +
	"case when jsonb_typeof(approval.state #> '{operation,genericApprovers}') = 'array' " +
	"then approval.state #> '{operation,genericApprovers}' else '[]'::jsonb end" +
	') as approver(team_name) ' +
	'where lower(team_name) = (' +
	SUBJECT_TEAM_NAME +
	')';

/**
 * An approval request is readable by its parties and by whoever may decide it.
 *
 * Written against unqualified column names on purpose: the same predicate is spliced into three
 * statements that alias the table differently — `findMany` uses none, `Sync.snapshot` uses `r`,
 * `Sync.diff` correlates through `visible` — and an unqualified reference resolves to the outer row
 * in all three. Nothing inside either subquery declares a `id`, so the correlation cannot
 * be captured by them.
 */
const READABLE_APPROVAL_REQUEST = Object.freeze({
	$sql:
		'"id"::text in (' +
		RAISED_BY_SUBJECT +
		') or "id"::text in (' +
		APPROVED_BY_SUBJECT_TEAM +
		') or "id"::text in (' +
		GENERICALLY_APPROVED_BY_SUBJECT_TEAM +
		')'
});

/**
 * Who raised a request is readable exactly when the request is — one rule, expressed once.
 *
 * Left unconditional this leaks the membership of every approval in the workspace: `requestor` is
 * two columns, one of which is a person, so a member who may not read a single `approval_request`
 * row could still enumerate who had raised each one.
 *
 * Scoped by `approval_request_id` rather than by `user_id = ${requestor.id}`. The narrower
 * form would answer "which requests did I raise" and hide the parties of a request the subject may
 * legitimately read as an approver — and would silently start hiding rows the day anything writes a
 * second requestor for one request.
 */
const READABLE_REQUESTOR = Object.freeze({
	$sql:
		'"approval_request_id" in (' +
		RAISED_BY_SUBJECT +
		') or "approval_request_id" in (' +
		APPROVED_BY_SUBJECT_TEAM +
		') or "approval_request_id" in (' +
		GENERICALLY_APPROVED_BY_SUBJECT_TEAM +
		')'
});

const OWN_CONVERSATION = Object.freeze({ $sql: '"user_id" = ${requestor.id}' });
const OWN_CONVERSATION_MESSAGE = Object.freeze({
	$sql:
		'"conversation_id" in (select owned."conversation_id" from chat_session owned ' +
		'where owned."user_id" = ${requestor.id})'
});
const OWN_NOTIFICATION = Object.freeze({ $sql: '"recipient" = ${requestor.id}' });

/**
 * Reading runtime state is allowed for any authenticated subject; writing never is, because the
 * owning service is the only writer. An authored `deny` policy still wins — this is an ordinary
 * declaration evaluated with the rest, not a bypass.
 */
export const SYSTEM_READ_POLICY: PolicyDeclaration = Object.freeze<PolicyDeclaration>({
	name: 'bolt.system-collections',
	description:
		'Read access to runtime-owned collections that authored queries and reports depend on.',
	effect: 'allow',
	/**
	 * What makes the sentence above true, and it was missing.
	 *
	 * A policy is otherwise selected by name, against the set `policiesHeld` builds from
	 * `+teams.ts` — and no template declares a team holding `bolt.system-collections`, because the
	 * whole reason this policy is merged rather than authored is that a workspace should not have to
	 * declare it. So it matched nobody: `subjectHasPolicy` fell through to `held.has(...)` on a set
	 * that could never contain this name, every grant below was inert, and the only thing making
	 * these collections readable was the `isAdministrator` short-circuit in `decide` and
	 * `rowPredicate`. An ordinary member — `field-operations`' non-admin controllers, reading
	 * `user` for the names behind `user_id` — was refused and rendered a column of dashes.
	 *
	 * It is not a bypass. The flag decides only *whether this policy applies to this subject*; the
	 * grants below still have to name the collection and the action, an authored `deny` still wins,
	 * and the field mask still applies. `COLONY_SYSTEM_POLICY` carries `system: true` instead and is
	 * deliberately excluded — see the flag's own note.
	 */
	authenticated: true,
	/**
	 * Identity is here only as a directory of names, and only because workspaces need one.
	 *
	 * The rest of this grant lets an authored query read the runtime's own bookkeeping — approval
	 * state a report filters on. `user` is not that: the row holds a person's address,
	 * roles and teams, and granting the whole of it to any authenticated subject would put the entire
	 * membership behind one signed-in session.
	 *
	 * But three workspaces render an owner picker, and they were written against a `user` table that
	 * the identity merge removed — `db.user.findMany` against a table that does not exist. What they
	 * actually need is an id and a display name, so that is exactly what the field mask allows.
	 * `findMany` applies `access.mask` to every row it returns, so the address, the roles and the
	 * teams are not merely unselected: they cannot be read through this grant at all. Replication is
	 * unaffected — `Sync.shape` and the change stream exclude every identity collection, so a
	 * directory is answered by a query and never mirrored into a browser.
	 *
	 * ## Enumerated, not derived
	 *
	 * This list used to be `SYSTEM_COLLECTIONS.filter(not identity).map(unconditional read)`, and the
	 * shape of that expression was the defect rather than an implementation detail of it: every
	 * runtime-owned collection that is not an identity table got an unconditional read of its whole
	 * contents, and a collection added here in future would have got one too, by default, with
	 * nothing in the diff to notice. Naming each grant means adding a runtime collection now forces
	 * an answer to "who may read this", because the alternative is a collection nobody can read at
	 * all — a visible failure rather than a silent grant.
	 *
	 * ## Why the two approval grants must stay the only ones on their collections
	 *
	 * `rowPredicate` **unions** the `where` of every matching grant, and a grant with no `where`
	 * compiles to `true` — at which point it short-circuits the union and the predicate is `true` for
	 * the whole collection. So a second, unconditional `read` on `approval_request` anywhere in this
	 * list does not add a case to the narrowing below, it deletes it.
	 */
	grants: [
		/**
		 * Row-scoped, where the grant above it used to be unconditional.
		 *
		 * There was a blanket `document_asset` read here, held by every authenticated subject, and it
		 * was load-bearing rather than lazy: `file()` emitted a bare `uuid` with no foreign key, so an
		 * asset row named no record it belonged to and no predicate had anything to reach through.
		 * Withholding it emptied every file column in every workspace. A `file()` value now carries
		 * the file — key, name, size, mime type — as a field of the record that owns it, so it
		 * inherits that record's row predicate and field mask, and the grant is gone with the
		 * collection rather than narrowed.
		 */
		{
			collection: collections.approval_request.name,
			action: 'read' as const,
			where: READABLE_APPROVAL_REQUEST
		},
		{
			collection: collections.requestor.name,
			action: 'read' as const,
			where: READABLE_REQUESTOR
		},
		{
			collection: collections.user.name,
			action: 'read' as const,
			fields: ['id', 'name']
		},
		{
			collection: collections.team.name,
			action: 'read' as const,
			fields: ['id', 'name']
		},
		{
			collection: collections.chat_session.name,
			action: 'read' as const,
			where: OWN_CONVERSATION
		},
		{
			collection: collections.chat_message.name,
			action: 'read' as const,
			where: OWN_CONVERSATION_MESSAGE
		},
		{
			collection: collections.bolt_notifications.name,
			action: 'read' as const,
			where: OWN_NOTIFICATION
		},
		{
			collection: collections.bolt_notifications.name,
			action: 'update' as const,
			where: OWN_NOTIFICATION,
			fields: ['read']
		}
	]
});

/**
 * The policies the runtime owns, present in every workspace whether or not it authored any.
 *
 * They are merged here, at the same seam the runtime's own collections are merged, and for the same
 * reason: they are part of what a bolt *is*, not part of what a workspace declares. That matters
 * more than it looks. The synthetic policies this replaces were written into the artifact by the
 * compiler, so what authority a deployed workspace had was decided when it was last built — and
 * removing a bad one meant rebuilding every workspace to be rid of it. Merged at definition load,
 * a change to this list takes effect the moment the runtime does.
 *
 * Neither is a bypass. Both are ordinary declarations evaluated by `decide` with the authored ones,
 * and an authored `deny` still wins over either. What is unusual about them is only how a subject
 * reaches one: no team can declare either name, so each carries the flag that selects it —
 * `authenticated` for the read policy, `system` for the host's — and those two flags are the whole
 * of what `PolicyDeclaration` has and `PolicyDefinition` does not.
 */
const BUILT_IN_POLICIES: ReadonlyArray<PolicyDeclaration> = Object.freeze([
	SYSTEM_READ_POLICY,
	COLONY_SYSTEM_POLICY
]);

/** Merges runtime-owned collections and policies into an authored definition without letting either shadow the other. */
export const withSystemCollections = <
	T extends {
		readonly collections: ReadonlyArray<
			CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
		>;
		readonly policies: ReadonlyArray<PolicyDeclaration>;
	}
>(
	definition: T
): T => {
	const shadowed = definition.collections
		.filter((collection) => {
			const systemCollection = SYSTEM_COLLECTIONS_BY_NAME.get(collection.name);
			return systemCollection !== undefined && systemCollection !== collection;
		})
		.map(({ name }) => name)
		.toSorted();
	if (shadowed.length > 0) {
		throw new TypeError(
			`Workspace collections cannot use runtime-owned names: ${shadowed.join(', ')}`
		);
	}
	const authored = new Set(definition.collections.map(({ name }) => name));
	const missing = SYSTEM_COLLECTIONS.filter(({ name }) => !authored.has(name));
	const declared = new Set(definition.policies.map(({ name }) => name));
	const absent = BUILT_IN_POLICIES.filter(({ name }) => !declared.has(name));
	if (missing.length === 0 && absent.length === 0) return definition;
	return {
		...definition,
		collections: [...definition.collections, ...missing],
		policies: [...definition.policies, ...absent]
	};
};
