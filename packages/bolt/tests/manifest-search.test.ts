import { expect, it } from '@effect/vitest';
import { compileAuthority } from '../src/engine/access/authority.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { EngineActor } from '../src/engine/contracts.ts';
import { manifestItems } from '../src/shell/finder/manifest.ts';
import { exposure } from '../src/engine/access/exposure.ts';
import { searchScopes } from '../src/shell/finder/model.ts';

const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en', secrets: { provider_key: { label: 'Provider key' } } },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	policies: { operator: { description: 'Run reports', grants: {}, automations: ['report'] } },
	automations: {
		report: { description: 'Generate a report', policies: ['operator'] },
		private_pipeline: { description: 'Private process', policies: ['operator'] }
	}
};
const actor: EngineActor = {
	kind: 'member',
	id: 'u1',
	email: null,
	phone: null,
	external: false,
	teams: [],
	teamPath: [],
	admin: false,
	party: null
};

it('search metadata honors authority and exposes declaration references without bodies or secret values', () => {
	const viewer = compileAuthority(
		manifest,
		{ actor, admin: false, policies: ['operator'] },
		'release'
	);
	const member = manifestItems(manifest, viewer, true);
	expect(member).toEqual([
		{
			kind: 'automation',
			name: 'report',
			description: 'Generate a report',
			href: '/command-center/automations?automation=report'
		}
	]);
	const admin = compileAuthority(
		manifest,
		{ actor: { ...actor, admin: true }, admin: true, policies: [] },
		'release'
	);
	const all = manifestItems(manifest, admin, true);
	const catalog = exposure(manifest, admin);
	expect(catalog.sys_user?.search).toEqual(['$label', 'name', 'email']);
	expect(catalog.approval_request?.search).toEqual(['$label', 'collection_name']);
	expect(
		searchScopes([], catalog, (key) => key).find(
			(scope) => scope.kind === 'model' && scope.model === 'approval_request'
		)
	).toMatchObject({ label: 'Approval requests', searchable: true });
	expect(
		searchScopes([], catalog, (key) => key).find(
			(scope) => scope.kind === 'model' && scope.model === 'sys_user'
		)
	).toMatchObject({ label: 'Users', searchable: true });
	expect(all.some((item) => item.name === 'private_pipeline')).toBe(true);
	expect(all.find((item) => item.kind === 'secret')).toEqual({
		kind: 'secret',
		name: 'provider_key',
		description: '',
		href: '/studio?file=src%2F%2Bsecrets.ts'
	});
	expect(all.find((item) => item.kind === 'policy')?.href).toContain('operator.policy.ts');
	expect(manifestItems(manifest, admin, false).every((item) => item.kind === 'automation')).toBe(
		true
	);
});
