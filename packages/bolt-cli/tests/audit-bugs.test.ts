// Reproduction for Bolt audit bug 27: `bolt check` judges a cron with the engine's own parser.
import { describe, expect, it } from 'vitest';
import { Result } from 'effect';
import { parse_cron } from '@norbital-ai/bolt/tooling';
import { checkRules } from '../src/compiler/check/rules.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';

const withCron = (cron: string): EngineManifest => ({
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: { ops: { description: 'Ops', grants: {} } },
	teams: {},
	automations: { tick: { description: 'Ticks', on: [{ cron }], policies: ['ops'] } },
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
});

describe('bug 27: one cron grammar for the build and the host', () => {
	it('flags exactly the crons the engine cannot schedule', () => {
		// '*/60' passes a field-by-field check but no minute ever matches it; ' @daily ' is a macro with spacing
		for (const cron of ['*/60 * * * *', '0 0 * 13 *', ' @daily ', '*/15 * * * *']) {
			const flagged = checkRules(withCron(cron), { automations: ['tick'] }, (_r, n) => n).some(
				(f) => f.code === 'automation/cron'
			);
			expect([cron, flagged]).toEqual([cron, Result.isFailure(parse_cron(cron))]);
		}
	});
});
