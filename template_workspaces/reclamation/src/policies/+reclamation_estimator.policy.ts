import type { Policy } from './$types.js';

/**
 * The estimator: prices a project against the rate matrix, and cannot move the matrix.
 *
 * Reclamation had no policy anywhere — not in this repository and not in Core's seed — so unlike the
 * other four templates this is a decision rather than a port. It answers **A5** in
 * `packages/pod/docs/CORE_REFACTOR.md`.
 *
 * **There is no owner column to scope to, on any of the five collections.** No `owner_id`, no
 * `user_id`, no `created_by`; the only system columns a model gets are `norbital_id`, the two
 * timestamps, `norbital_sys_period`, `norbital_row_version`, and `norbital_approval_id`. A reclamation
 * project is a shared workbook — one site, one stitched model, one set of numbers that a team argues
 * about — so per-user ownership would be a fiction invented to satisfy a policy rather than a fact
 * about the domain. Adding an owner column here to enable requestor scoping would change the schema
 * to justify the permission rule instead of the other way round.
 *
 * So the narrowing is by *what a row is*, which the schema does record:
 *
 * - the rate matrix is read-only, which is the separation the whole role exists for;
 * - a document that feeds the stitch is not writable, because writing one changes the geometry;
 * - an estimate that has been issued is not editable, because it has left the building.
 *
 * Both conditions use `$sql`, never `RAW`. `RAW` is a function; a grant is stored as jsonb, the
 * function is dropped, and the grant lands with empty conditions — which the guard reads as
 * *unconditional*. A narrowing that silently inverts into a widening is the worst failure a
 * permission rule can have, so `definePolicy` refuses it.
 *
 * `IS DISTINCT FROM` rather than `<>` is deliberate: on a create the mutation-side matcher evaluates
 * the expression against a virtual row built from the payload, with every unsupplied column bound to
 * NULL. `"status" <> 'issued'` would evaluate to NULL — and therefore deny — for an estimator who
 * simply did not type a status. `IS DISTINCT FROM` is true there, which is the intended answer.
 */

/**
 * A document that is filed, not parsed.
 *
 * `category: 'reconstruction'` is read by the stitch hook and changes the model — an extra section
 * sheet adds profiles, an extra survey adds soundings. Tender returns and reference material are
 * never parsed. An estimator files the second kind; changing the first is an engineering act.
 */
const filedDocument = { $sql: `"category" IS DISTINCT FROM 'reconstruction'` } as const;

/**
 * An estimate that has not yet left the building.
 *
 * `issued` is a commercial commitment and `superseded` is history; neither is something to edit in
 * place. Applied to `create` as well as `update`, so an estimator cannot post a row that arrives
 * already issued and skip the draft it should have been reviewed as.
 */
const editableEstimate = {
	$sql: `"status" IS DISTINCT FROM 'issued' AND "status" IS DISTINCT FROM 'superseded'`
} as const;

export default {
	name: 'Reclamation Estimator',
	description:
		'Prices reclamation projects: reads the site model and the rate matrix, writes draft estimates and filed documents.',
	apps: ['reclamation_projects'],
	grants: [
		// The project and its derived geometry are read-only. The three primary documents live on the
		// project row and drive the stitch, so a write here silently re-runs the model.
		{ collection: 'reclamation_projects', action: 'read' },
		{ collection: 'site_reconstructions', action: 'read' },

		{ collection: 'project_documents', action: 'read' },
		{ collection: 'project_documents', action: 'create', where: filedDocument },
		{ collection: 'project_documents', action: 'update', where: filedDocument },

		// The matrix is readable and nothing more. An estimator who can edit the rates they price
		// against is not being checked by anything — that is why `reclamation_cost_matrix` is absent
		// from `apps` as well: the app would be a dead link, and a policy should not offer one.
		{ collection: 'cost_rates', action: 'read' },

		// Estimates are the working surface. Every estimate is readable — pricing is compared, not kept
		// private — but only an unissued one can be written.
		{ collection: 'cost_estimates', action: 'read' },
		{ collection: 'cost_estimates', action: 'create', where: editableEstimate },
		{ collection: 'cost_estimates', action: 'update', where: editableEstimate }

		// No `delete` anywhere. An estimate is superseded, not removed, and the status enum says so.
	]
} satisfies Policy;
