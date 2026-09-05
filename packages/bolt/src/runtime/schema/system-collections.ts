import { Record as EffectRecord } from 'effect';
import { compileModel } from '#lib/authoring/model-introspection.js';
import { SYSTEM_COLLECTION_MODELS } from '#lib/authoring/system-models.js';
import {
	collection,
	type CollectionDefinition,
	type FieldDefinition,
	type PolicyDeclaration,
	type RelationDefinition
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
	collections.agent_task,
	collections.agent_plan,
	collections.agent_message,
	collections.agent_inbox,
	collections.agent_run,
	collections.agent_usage,
	collections.automation_run,
	collections.bolt_notifications
]);

/** Runtime-owned names, used at boundaries that must expose only a workspace's authored model. */
export const SYSTEM_COLLECTION_NAMES: ReadonlySet<string> = new Set(
	SYSTEM_COLLECTIONS.map(({ name }) => name)
);

const SYSTEM_COLLECTIONS_BY_NAME = new Map(
	SYSTEM_COLLECTIONS.map((definition) => [definition.name, definition] as const)
);

const SUBJECT_ID = Object.freeze({ $subject: 'id' as const });
const OWN_TASK = Object.freeze({ subject_id: { eq: SUBJECT_ID } });
const WORKBENCH_TASK = Object.freeze({ audience: { eq: 'workbench' } });
const OWN_TASK_RELATION = Object.freeze({
	task: { some: OWN_TASK }
});
const WORKBENCH_TASK_RELATION = Object.freeze({
	task: { some: WORKBENCH_TASK }
});
const OWN_USAGE = Object.freeze({
	run: { some: OWN_TASK_RELATION }
});
const WORKBENCH_USAGE = Object.freeze({
	run: { some: WORKBENCH_TASK_RELATION }
});
const OWN_OR_WORKBENCH_TASK = Object.freeze({ OR: [OWN_TASK, WORKBENCH_TASK] });
const OWN_OR_WORKBENCH_TASK_RELATION = Object.freeze({
	OR: [OWN_TASK_RELATION, WORKBENCH_TASK_RELATION]
});
const OWN_OR_WORKBENCH_USAGE = Object.freeze({ OR: [OWN_USAGE, WORKBENCH_USAGE] });
const OWN_NOTIFICATION = Object.freeze({ recipient: { eq: SUBJECT_ID } });
const READABLE_APPROVAL_REQUEST = Object.freeze({ id: { approvalParty: true } });
const READABLE_REQUESTOR = Object.freeze({ approval_request_id: { approvalParty: true } });

const systemRelationship = (definition: RelationDefinition): RelationDefinition =>
	Object.freeze({
		...definition,
		...(definition.from === undefined ? {} : { from: Object.freeze({ ...definition.from }) }),
		...(definition.to === undefined ? {} : { to: Object.freeze({ ...definition.to }) })
	});

/** Exact runtime relationship identities consumed by the same compiler as authored relationships. */
export const SYSTEM_RELATIONSHIPS: ReadonlyArray<RelationDefinition> = Object.freeze([
	systemRelationship({
		name: 'requestors',
		source: 'approval_request',
		target: 'requestor',
		cardinality: 'many',
		from: { collection: 'approval_request', column: 'id' },
		to: { collection: 'requestor', column: 'approval_request_id' }
	}),
	systemRelationship({
		name: 'approvalRequest',
		source: 'requestor',
		target: 'approval_request',
		cardinality: 'one',
		from: { collection: 'requestor', column: 'approval_request_id' },
		to: { collection: 'approval_request', column: 'id' }
	}),
	systemRelationship({
		name: 'parentTask',
		source: 'agent_task',
		target: 'agent_task',
		cardinality: 'one',
		from: { collection: 'agent_task', column: 'parent_id' },
		to: { collection: 'agent_task', column: 'id' }
	}),
	systemRelationship({
		name: 'children',
		source: 'agent_task',
		target: 'agent_task',
		cardinality: 'many',
		from: { collection: 'agent_task', column: 'id' },
		to: { collection: 'agent_task', column: 'parent_id' }
	}),
	systemRelationship({
		name: 'activePlan',
		source: 'agent_task',
		target: 'agent_plan',
		cardinality: 'one',
		from: { collection: 'agent_task', column: 'active_plan_id' },
		to: { collection: 'agent_plan', column: 'id' }
	}),
	systemRelationship({
		name: 'activeRun',
		source: 'agent_task',
		target: 'agent_run',
		cardinality: 'one',
		from: { collection: 'agent_task', column: 'active_run_id' },
		to: { collection: 'agent_run', column: 'id' }
	}),
	...(
		[
			['plans', 'agent_plan'],
			['messages', 'agent_message'],
			['directives', 'agent_inbox'],
			['runs', 'agent_run']
		] as const
	).map(([name, target]) =>
		systemRelationship({
			name,
			source: 'agent_task',
			target,
			cardinality: 'many' as const,
			from: { collection: 'agent_task', column: 'id' },
			to: { collection: target, column: 'task_id' }
		})
	),
	...['agent_plan', 'agent_message', 'agent_inbox', 'agent_run'].map((source) =>
		systemRelationship({
			name: 'task',
			source,
			target: 'agent_task',
			cardinality: 'one' as const,
			from: { collection: source, column: 'task_id' },
			to: { collection: 'agent_task', column: 'id' }
		})
	),
	systemRelationship({
		name: 'run',
		source: 'agent_message',
		target: 'agent_run',
		cardinality: 'one',
		from: { collection: 'agent_message', column: 'run_id' },
		to: { collection: 'agent_run', column: 'id' }
	}),
	systemRelationship({
		name: 'supersedes',
		source: 'agent_message',
		target: 'agent_message',
		cardinality: 'one',
		from: { collection: 'agent_message', column: 'supersedes_id' },
		to: { collection: 'agent_message', column: 'id' }
	}),
	systemRelationship({
		name: 'message',
		source: 'agent_inbox',
		target: 'agent_message',
		cardinality: 'one',
		from: { collection: 'agent_inbox', column: 'message_id' },
		to: { collection: 'agent_message', column: 'id' }
	}),
	systemRelationship({
		name: 'claimedRun',
		source: 'agent_inbox',
		target: 'agent_run',
		cardinality: 'one',
		from: { collection: 'agent_inbox', column: 'claimed_run_id' },
		to: { collection: 'agent_run', column: 'id' }
	}),
	systemRelationship({
		name: 'directive',
		source: 'agent_run',
		target: 'agent_inbox',
		cardinality: 'one',
		from: { collection: 'agent_run', column: 'directive_id' },
		to: { collection: 'agent_inbox', column: 'id' }
	}),
	systemRelationship({
		name: 'messages',
		source: 'agent_run',
		target: 'agent_message',
		cardinality: 'many',
		from: { collection: 'agent_run', column: 'id' },
		to: { collection: 'agent_message', column: 'run_id' }
	}),
	systemRelationship({
		name: 'usage',
		source: 'agent_run',
		target: 'agent_usage',
		cardinality: 'many',
		from: { collection: 'agent_run', column: 'id' },
		to: { collection: 'agent_usage', column: 'run_id' }
	}),
	systemRelationship({
		name: 'run',
		source: 'agent_usage',
		target: 'agent_run',
		cardinality: 'one',
		from: { collection: 'agent_usage', column: 'run_id' },
		to: { collection: 'agent_run', column: 'id' }
	})
]);

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
	 * teams are not merely unselected: they cannot be read through this grant at all. The sync path
	 * is unaffected too — a browser receives answers to the queries it registered on `sync.connect`,
	 * never a wholesale mirror of a collection, so a directory is answered by a query and nothing
	 * wider.
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
			collection: collections.agent_task.name,
			action: 'read' as const,
			where: OWN_OR_WORKBENCH_TASK
		},
		...[collections.agent_plan, collections.agent_message, collections.agent_inbox].map(
			(systemCollection) => ({
				collection: systemCollection.name,
				action: 'read' as const,
				where: OWN_OR_WORKBENCH_TASK_RELATION
			})
		),
		{
			collection: collections.agent_run.name,
			action: 'read' as const,
			where: OWN_OR_WORKBENCH_TASK_RELATION,
			fields: [
				'id',
				'task_id',
				'directive_id',
				'epoch',
				'mode',
				'phase',
				'input_through_sequence',
				'model_id',
				'status',
				'created_at',
				'updated_at',
				'row_version'
			]
		},
		{
			collection: collections.agent_usage.name,
			action: 'read' as const,
			where: OWN_OR_WORKBENCH_USAGE
		},
		{
			collection: collections.automation_run.name,
			action: 'read' as const
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

/** Runtime controls available to a workspace administrator outside authored data policy. */
const WORKSPACE_ADMINISTRATION_POLICY: PolicyDeclaration = Object.freeze<PolicyDeclaration>({
	name: 'bolt.workspace-administration',
	description: 'Workspace identity, environment and team-preview administration.',
	effect: 'allow',
	administrator: true,
	actions: ['manage', 'impersonate'],
	capabilities: { apps: ['identity', 'secrets'] }
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
 * The administration declaration covers runtime controls only. Administrator access to authored
 * collections, apps and agents is a trusted status short-circuit at the access boundary, and team
 * preview drops that status before it reaches the boundary.
 */
const BUILT_IN_POLICIES: ReadonlyArray<PolicyDeclaration> = Object.freeze([
	SYSTEM_READ_POLICY,
	WORKSPACE_ADMINISTRATION_POLICY,
	COLONY_SYSTEM_POLICY
]);

/** Definitions already augmented by `withSystemCollections`; re-entry returns the same reference. */
const augmentedDefinitions = new WeakSet<object>();

/**
 * Merges runtime-owned collections and policies into an authored definition. Idempotent:
 * an already-augmented definition returns by reference. `Workspace.layer` is the single
 * runtime augmenter; compile-time callers accept either form and rely on this fast path.
 */
export const withSystemCollections = <
	T extends {
		readonly collections: ReadonlyArray<
			CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
		>;
		readonly policies: ReadonlyArray<PolicyDeclaration>;
		readonly relations?: ReadonlyArray<RelationDefinition>;
	}
>(
	definition: T
): T => {
	if (augmentedDefinitions.has(definition)) return definition;
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
	const relationKeys = new Set(
		(definition.relations ?? []).map((relation) => `${relation.source}\u0000${relation.name}`)
	);
	const missingRelations = SYSTEM_RELATIONSHIPS.filter(
		(relation) => !relationKeys.has(`${relation.source}\u0000${relation.name}`)
	);
	if (missing.length === 0 && absent.length === 0 && missingRelations.length === 0)
		return definition;
	const augmented = {
		...definition,
		collections: [...definition.collections, ...missing],
		policies: [...definition.policies, ...absent],
		relations: [...(definition.relations ?? []), ...missingRelations]
	} as T;
	augmentedDefinitions.add(augmented);
	return augmented;
};
