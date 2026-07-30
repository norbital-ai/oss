import type { Policy } from './$types.js';

/**
 * Project operations: the delivery surface, read-only.
 *
 * Ported verbatim from Core's `seed/construction/steps/policies.ts`, which built all three
 * construction policies from one `constructionCollections` list and one `readGrants` map. The three
 * declarations repeat that list rather than sharing it, because `src/policies` admits only
 * `+<name>.policy.ts` files — a shared `collections.ts` next to them is a `POLICY_NAME_INVALID`
 * diagnostic, not a module. Twelve literal lines per file is the cost of keeping the whole grant set
 * of a policy readable in the file that names it.
 *
 * Every grant is unconditional. That is deliberate and matches the seed: construction has no
 * requestor-bearing column on any of these collections, so there is nothing to scope to. The
 * narrowing is `apps`, not `where` — this policy opens exactly one application, and the three
 * policies differ only in which.
 *
 * The key is the filename, and it is the key the seeded row already carries
 * (`construction_project_workspace`), so reconciliation upserts that row instead of inserting a
 * second one and leaving every `team.policy_id` pointing at the original.
 */
export default {
	name: 'Construction Project Workspace',
	description: 'Project operations, issues, and commercial readiness.',
	apps: ['construction_project_workspace'],
	grants: [
		{ collection: 'projects', action: 'read' },
		{ collection: 'site_locations', action: 'read' },
		{ collection: 'rfis', action: 'read' },
		{ collection: 'defects', action: 'read' },
		{ collection: 'workers', action: 'read' },
		{ collection: 'certification_types', action: 'read' },
		{ collection: 'permits_to_work', action: 'read' },
		{ collection: 'jobs', action: 'read' },
		{ collection: 'job_assignments', action: 'read' },
		{ collection: 'payment_claims', action: 'read' },
		{ collection: 'bim_reference_matrix', action: 'read' },
		{ collection: 'asset_documents', action: 'read' }
	]
} satisfies Policy;
