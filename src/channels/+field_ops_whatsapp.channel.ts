import type { Channel } from './$types.js';

/** Analysis host tools — inspect and run scripts; no write/edit/deps/deploy tools. */
const ANALYSIS_HOST_TOOLS = [
	'sandbox_bash',
	'sandbox_read',
	'sandbox_ls',
	'sandbox_grep',
	'sandbox_ast_grep',
	'sandbox_glob',
	'sandbox_quality_audit',
	'sandbox_list_skills',
	'sandbox_read_skill'
] as const;

/**
 * Field operations over WhatsApp.
 *
 * Runs as the channel's own agent principal under the controller policy, so it can read and write
 * every field-ops collection the same way a controller would in the app — jobs, assignments, sites,
 * certifications, variations, photo evidence. Host tools are the analysis allowlist above only.
 */
export default {
	transport: 'whatsapp',
	policy: 'field_ops_controller',
	description: 'Field operations WhatsApp agent',
	hostTools: [...ANALYSIS_HOST_TOOLS],
	hostSandbox: { workspace: 'read-only' },
	task:
		'You are the field-operations agent for this company on WhatsApp. Help controllers and ' +
		'contractors with jobs, assignments, sites, certifications, variation requests, and photo ' +
		'evidence. Read and update records as needed under the controller policy. You may run ' +
		'analysis scripts in the sandbox (bash) and inspect files for diagnosis; the worktree is ' +
		'read-only — use scratch under `.tmp` for ephemeral output. Do not edit workspace source, add ' +
		'dependencies, or change the repository. Prefer concrete record facts over guesses. Do not ' +
		'invent IDs, dates, or certification status. When a request needs an approval or a human ' +
		'decision outside the data you can see, say so clearly.'
} satisfies Channel;
