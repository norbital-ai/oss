import { parseOverrides } from './lib/run-stitch.js';
import { refuse } from '@norbital-ai/pod/authoring';
import type { Hooks } from './$types.js';

/**
 * Validate what has to be right before the project row lands.
 *
 * An override blob has to be JSON, and the tuning cells have to be sane — both are same-transaction
 * checks on the record being written, which is the whole of what a hook is for.
 *
 * The reconstruction is *not* here. It reads three file assets, walks a survey grid, and appends a
 * revision to `site_reconstructions` — durable work against another collection, which by definition
 * belongs to an automation that runs after commit. `src/automation/+reconstruct_created_project.ts`
 * and `+reconstruct_updated_project.ts` own it, and a stitch failure now records a failed revision
 * instead of rolling back the project the engineer just saved.
 */

function validateTuning(input: {
	integration_cell_m?: number | null;
	render_cell_m?: number | null;
	stitch_overrides?: string | null;
}): void {
	try {
		parseOverrides(input.stitch_overrides);
	} catch (cause) {
		refuse(cause instanceof Error ? cause.message : String(cause));
	}
	for (const [label, value] of [
		['Integration cell', input.integration_cell_m],
		['Render cell', input.render_cell_m]
	] as const) {
		if (value == null) continue;
		if (!Number.isFinite(value) || value < 0.5 || value > 100) {
			refuse(`${label} size must be between 0.5 m and 100 m.`);
		}
	}
}

export default {
	create: {
		before: {
			description:
				'Refuses a new project whose stitch_overrides blob is not valid JSON or whose integration_cell_m or render_cell_m falls outside 0.5 m to 100 m.',
			handler: async ({ input }) => {
				validateTuning(input);
				return input;
			}
		}
	},
	update: {
		before: {
			description:
				'Re-checks the stitch_overrides JSON and the integration_cell_m and render_cell_m grid sizes on every edit, so a bad tuning value cannot reach the reconstruction engine.',
			handler: async ({ input }) => {
				validateTuning(input);
				return input;
			}
		}
	}
} satisfies Hooks;
