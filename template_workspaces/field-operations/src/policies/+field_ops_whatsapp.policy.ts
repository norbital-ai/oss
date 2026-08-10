import type { Policy } from './$types.js';

/**
 * The WhatsApp channel principal: update existing job assignments, nothing else.
 *
 * This policy is held by the synthetic agent user the channel runs as — not by any person — so
 * grants are unconditional: there is no requestor identity behind a channel message, and the
 * platform cannot scope grants by conversation or messenger. That is exactly why the grant list is
 * this short and why every other capability is absent:
 *
 * - Only `job_assignments` `update` exists. The agent may advance a caller's progress on an existing
 *   assignment and record completion, location, notes, and charges. It cannot create an assignment
 *   (or anything else), cannot delete one, and has no read grant anywhere — `read_collection` is
 *   refused for every collection, so it cannot snoop, and it never sees photo `flags`, a `suspect`
 *   status, or the `site_identity_*` markers because it cannot read the rows that carry them.
 * - No apps: the channel principal never opens a surface.
 *
 * Two limits are the platform's, not this file's, and they are stated so nobody mistakes the lock
 * for a stronger one: the grant covers every column of `job_assignments` (there is no column-level
 * grant, so the agent could in principle write the integrity fields — the channel `task` forbids
 * it, and a platform column-level grant is the real fix), and the `update` response returns the
 * full updated row, so the agent sees the row it just wrote. Everything else — which assignment a
 * caller means, who is calling — cannot be resolved without a read grant, by design.
 */
export default {
	name: 'Field Operations WhatsApp',
	description:
		'Update-only access to existing job assignments for the WhatsApp channel agent. No creates, no deletes, no reads.',
	apps: [],
	grants: [{ collection: 'job_assignments', action: 'update' }]
} satisfies Policy;
