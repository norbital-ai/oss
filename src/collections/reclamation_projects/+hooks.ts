import { PROJECT_STITCH_COLUMNS, stitchDriver } from '../../lib/reclamation/stitch-driver.js';
import { parseOverrides, runStitchForProject } from './lib/run-stitch.js';
import { refuse } from '@norbital-ai/pod/authoring';
import type { Hooks } from './$types.js';

/**
 * The 3D reconstruction runs here.
 *
 * `before` validates only what has to be right before the row lands: an override
 * blob has to be JSON, and the tuning cells have to be sane. The stitch itself
 * runs in `after`, because it reads file assets, walks a survey grid, and writes
 * a `site_reconstructions` revision — work that belongs after the project row is
 * durable, not inside the write that creates it.
 *
 * The project row is never mutated by these hooks, so a stitch cannot re-enter
 * them. Status is read from the newest reconstruction revision instead.
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
		before: async ({ input }) => {
			validateTuning(input);
			return input;
		},
		after: async ({ record, api }) => {
			await runStitchForProject(
				record,
				stitchDriver(api, (payload) => api.db.mutate('site_reconstructions', [payload]))
			);
		}
	},
	update: {
		before: async ({ input }) => {
			validateTuning(input);
			return input;
		},
		after: async ({ record, api }) => {
			// The driver compares the current documents and settings against the
			// fingerprint on the newest run, so an unrelated edit — a rename, a
			// status change — does not re-integrate the site.
			await runStitchForProject(
				record,
				stitchDriver(api, (payload) => api.db.mutate('site_reconstructions', [payload]))
			);
		}
	}
} satisfies Hooks;
