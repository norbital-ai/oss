import {
	collection,
	field,
	type CollectionDefinition,
	type FieldDefinition,
	type PolicyDeclaration
} from '../../authoring/workspace-schema.js';
import { COLONY_SYSTEM_POLICY } from '../access/system-principal.js';

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
		/**
		 * Whether this person administers the workspace. `normal` or `admin`, and nothing else.
		 *
		 * Deliberately *not* a role and deliberately not folded into `kind`. `kind` answers "is this a
		 * person or a service", which stays true independently of authority — a service row is not an
		 * administrator and an administrator is still a person, so one column cannot carry both without
		 * losing one of the two answers.
		 *
		 * It is not a role because `subjectHasPolicy` matches a subject to a policy by role, and there
		 * is no policy called `admin` in any workspace, and a team that named one would confer
		 * nothing. The arrangement this replaces put the founder in every team the workspace
		 * mentioned, which made "administers the workspace" indistinguishable from "is simultaneously
		 * an employee, a supervisor, a manager and an HR controller"; any change to the ladder
		 * silently changed what an administrator was.
		 *
		 * Administration is a property of the person, so it lives on the person. `AccessControl`
		 * short-circuits on it before it consults a single policy.
		 *
		 * `sqlDefault` is what makes seeding safe: a row written by the seed loader or created by
		 * Better Auth on first sign-in is `normal` without anybody having to remember to say so.
		 */
		status: field.string({ required: true, sqlDefault: "'normal'" }),
		/** The workspace this subject belongs to — Bolt's concept, not Better Auth's. */
		tenantId: field.string({ indexed: true }),
		/**
		 * The one team this person belongs to, or null.
		 *
		 * One, not many, and that is the simplification the rest of this design rests on: there is no
		 * union across memberships to resolve, no join table, and every combination of authority
		 * anybody actually holds has a name in `+teams.ts` that appears in a diff. Two people who
		 * need different authority belong to two teams; one person who needs a combination belongs to
		 * a team that is that combination.
		 *
		 * Nullable, because a person can exist before anybody has placed them — a founder admitted
		 * into an empty workspace, an address that has just verified a code. Such a subject holds no
		 * policies at all, which is the correct answer and a visible one.
		 */
		team_id: field.uuid({ indexed: true }),
		/**
		 * The messaging identities this person has proven are theirs — a WhatsApp number, a Telegram
		 * handle — as `[{ type, verified, ...address }]`.
		 *
		 * This is what makes an inbound channel message attributable. A transport hands the runtime an
		 * address and nothing else, and `bolt_auth_user` held no address of any kind except `email`, so
		 * a channel declaring `audience: 'authenticated'` had literally nothing to authenticate a
		 * sender against — the audience was decorative.
		 *
		 * **It confers nothing.** A row here answers one question — is this sender someone we know —
		 * and never widens what the resulting turn may do: capability on a channel comes from the
		 * channel's declared `policy` and from nowhere else. A verified number belonging to a workspace
		 * administrator still reaches exactly what the channel declares, which is why this is an
		 * address book and not a credential.
		 *
		 * `verified` is stored rather than implied by the row existing, because the two are genuinely
		 * different states: an administrator recording a contractor's number is a claim, and only a
		 * completed proof of possession makes it an identity. `Channels.receive` matches on
		 * `verified === true` alone, so an unproven claim is inert rather than trusted.
		 *
		 * Json rather than its own collection: it is read only when a message arrives, always for one
		 * person at a time, and never queried across people. A join table would buy a query nothing
		 * asks.
		 */
		channels: field.json()
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

/**
 * A team: who a person belongs to, and nothing about what that entitles them to.
 *
 * The split is the point, and it is the whole reason this collection can be a runtime row at all.
 * **Membership** changes constantly and belongs to an operator — somebody joins, somebody moves,
 * somebody leaves — so it is a row, edited from a dashboard, with no deploy. **Authority** is which
 * policies a team holds, and that is declared in the workspace's own `+teams.ts` and compiled into
 * the release. A row that granted a policy would be a privilege escalation performed with an
 * `update` statement, in a place no diff, no review and no type check can see.
 *
 * So a team row carries a name and a position, and the name is what binds it to the authored map.
 * A team whose name the release does not declare is inert rather than broken: it holds no policies,
 * it still works as an approval target, and a deploy that removes a team therefore takes its
 * authority away without orphaning anybody.
 *
 * `parent_id` is the hierarchy. It is nullable, self-referential, and `set null` on delete — a team
 * disappearing must not take its children's rows with it.
 */
const team = collection({
	name: 'bolt_team',
	fields: {
		/**
		 * The binding to the authored map, and to every `approvers` entry that names this team.
		 *
		 * Unique, and compared folded wherever it is compared. Today `roles` matched policies
		 * case-insensitively while `teams` matched approvers case-sensitively — two string arrays
		 * with two different rules, and the second one silently produced approvals nobody could
		 * decide. One rule, enforced by the index.
		 */
		name: field.string({ required: true, indexed: true, unique: true }),
		description: field.string(),
		/** The parent in the hierarchy, or null at the root. See `resolveTeamPolicies`. */
		parent_id: field.uuid()
	},
	history: false
});

/**
 * The collections authentication itself reads, and therefore the ones a host must create before it
 * can migrate anything else. `bolt_team` is among them because resolving a subject now joins it: a
 * host that created the auth tables and not this one would authenticate nobody.
 */
export const IDENTITY_COLLECTIONS: ReadonlyArray<
	CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
> = Object.freeze([authUser, authSession, authAccount, authVerification, authConfig, team]);

export const SYSTEM_COLLECTIONS: ReadonlyArray<
	CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
> = Object.freeze([...IDENTITY_COLLECTIONS, approvalRequest, requestor]);

export const SYSTEM_COLLECTION_NAMES: ReadonlySet<string> = new Set(
	SYSTEM_COLLECTIONS.map(({ name }) => name)
);

/**
 * The approval requests this subject raised.
 *
 * The `requestor` join table is the only record of who that was: `approval_request` carries the
 * collection, the record, the action and the status, and no requestor column at all, so "is this
 * mine" cannot be answered from the row itself. `Approvals.request` writes exactly one `requestor`
 * row per request, in the same block that projects the `approval_request` row.
 *
 * `${requestor.norbital_id}` is **not** interpolated by JavaScript here — these are single-quoted
 * strings, so the literal token reaches the policy compiler, which binds `subject.userId` as a
 * parameter. `party` rather than `requestor` as the alias only because the table and the token
 * prefix share a spelling and a reader should not have to work out which is which.
 */
const RAISED_BY_SUBJECT =
	'select party."approval_request_id" from requestor party ' +
	'where party."user_id" = ${requestor.norbital_id}';

/**
 * The name of this subject's one team, folded — reached by a join, because no token names it.
 *
 * `AccessControl.subjectValue` resolves exactly three paths — `requestor.norbital_id`,
 * `requestor.tenantId`, `requestor.email` — so a team is something the predicate has to go and look
 * up. `bolt_auth_user.team_id` is one team, nullable, and a subject nobody has placed yields no row:
 * the scalar subquery is then `null`, `lower(...) = null` is `null`, and the approver leg below
 * matches nothing. Absence narrows, which is the only safe direction for it to go.
 *
 * The subject's own team and not `teamPath`. `Approvals.decide` matches `step.approvers` against
 * `subject.team` alone, so anything wider here would show a member approvals they are not eligible
 * to decide — and `teamPath` runs *downward* through the hierarchy unconditionally, which is
 * the opposite of "their higher ups".
 */
const SUBJECT_TEAM_NAME =
	'select lower(subject_team."name") from bolt_auth_user subject_user ' +
	'join bolt_team subject_team on subject_team."norbital_id" = subject_user."team_id" ' +
	'where subject_user."norbital_id"::text = ${requestor.norbital_id}';

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
 * An approval request is readable by its parties and by whoever may decide it.
 *
 * Written against unqualified column names on purpose: the same predicate is spliced into three
 * statements that alias the table differently — `findMany` uses none, `Sync.snapshot` uses `r`,
 * `Sync.diff` correlates through `visible` — and an unqualified reference resolves to the outer row
 * in all three. Nothing inside either subquery declares a `norbital_id`, so the correlation cannot
 * be captured by them.
 */
const READABLE_APPROVAL_REQUEST = Object.freeze({
	$sql:
		'"norbital_id"::text in (' +
		RAISED_BY_SUBJECT +
		') or "norbital_id"::text in (' +
		APPROVED_BY_SUBJECT_TEAM +
		')'
});

/**
 * Who raised a request is readable exactly when the request is — one rule, expressed once.
 *
 * Left unconditional this leaks the membership of every approval in the workspace: `requestor` is
 * two columns, one of which is a person, so a member who may not read a single `approval_request`
 * row could still enumerate who had raised each one.
 *
 * Scoped by `approval_request_id` rather than by `user_id = ${requestor.norbital_id}`. The narrower
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
		')'
});

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
	 * A policy is otherwise selected by name, against the set `policiesHeldByTeam` builds from
	 * `+teams.ts` — and no template declares a team holding `bolt.system-collections`, because the
	 * whole reason this policy is merged rather than authored is that a workspace should not have to
	 * declare it. So it matched nobody: `subjectHasPolicy` fell through to `held.has(...)` on a set
	 * that could never contain this name, every grant below was inert, and the only thing making
	 * these collections readable was the `isAdministrator` short-circuit in `decide` and
	 * `rowPredicate`. An ordinary member — `field-operations`' non-admin controllers, reading
	 * `bolt_auth_user` for the names behind `user_id` — was refused and rendered a column of dashes.
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
	 * state a report filters on. `bolt_auth_user` is not that: the row holds a person's address,
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
			collection: approvalRequest.name,
			action: 'read' as const,
			where: READABLE_APPROVAL_REQUEST
		},
		{ collection: requestor.name, action: 'read' as const, where: READABLE_REQUESTOR },
		{ collection: authUser.name, action: 'read' as const, fields: ['norbital_id', 'name'] }
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
export const BUILT_IN_POLICIES: ReadonlyArray<PolicyDeclaration> = Object.freeze([
	SYSTEM_READ_POLICY,
	COLONY_SYSTEM_POLICY
]);

/**
 * The names above, for the surfaces that list policies *as teams*.
 *
 * `impersonationTeams` renders one entry per policy into the administrator's team picker, and a
 * built-in is not a body of staff — the deleted `admin` policy showed up there as though it were
 * one. Anything that offers policies to a person filters on this.
 */
export const BUILT_IN_POLICY_NAMES: ReadonlySet<string> = new Set(
	BUILT_IN_POLICIES.map(({ name }) => name)
);

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
