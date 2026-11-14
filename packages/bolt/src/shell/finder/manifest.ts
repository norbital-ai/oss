import { Schema } from 'effect';
import type { EngineManifest } from '../../engine/manifest.ts';
import type { Authority } from '../../engine/contracts.ts';
import { automation_inputs, kiosk_nav } from '../nav.ts';

/** Discoverable declaration metadata; never declaration bodies, credentials or record data. */
export const ManifestItemSchema = Schema.Struct({
	kind: Schema.Literals([
		'automation',
		'integration',
		'connection',
		'mcp',
		'policy',
		'team',
		'relationship',
		'field',
		'skill',
		'secret',
		'kiosk',
		'group',
		'workspace',
		'sync'
	]),
	name: Schema.String,
	description: Schema.String,
	href: Schema.String
});
export type ManifestItem = typeof ManifestItemSchema.Type;

export function manifestItems(
	m: EngineManifest,
	authority: Authority,
	studio: boolean
): ManifestItem[] {
	const source = (path: string) => `/studio?file=${encodeURIComponent(path)}`;
	const automations = automation_inputs(m, authority);
	const items: ManifestItem[] = Object.entries(automations).map(([name, spec]) => ({
		kind: 'automation',
		name,
		description: spec.description ?? '',
		href: `/command-center/automations?automation=${encodeURIComponent(name)}`
	}));
	items.push(
		...kiosk_nav(m, authority).map((kiosk) => ({
			kind: 'kiosk' as const,
			name: kiosk.name,
			description: kiosk.title,
			href: kiosk.href
		}))
	);
	if (!authority.admin || !studio) return items;
	const add = (
		kind: ManifestItem['kind'],
		declarations: object | undefined,
		path: (name: string) => string
	) => {
		for (const name of Object.keys(declarations ?? {})) {
			if (items.some((item) => item.kind === kind && item.name === name)) continue;
			items.push({ kind, name, description: '', href: source(path(name)) });
		}
	};
	add('automation', m.automations, (name) => `src/automation/+${name}.automation.ts`);
	add('integration', m.integrations, (name) => `src/integration/${name}/+integration.ts`);
	add('mcp', m.mcp, (name) => `src/agent/mcp/+${name}.mcp.ts`);
	add('policy', m.policies, (name) => `src/access_control/policy/+${name}.policy.ts`);
	add('team', m.teams, () => 'src/access_control/team/+team.ts');
	add('relationship', m.relationships, (name) => `src/data/model/${name.split('.')[0]}/+model.ts`);
	add('field', m.custom_fields, (name) => `src/data/custom_field/${name}/+custom_field.ts`);
	add('skill', m.agent.skills, (name) => `src/agent/skill/${name}/+skill.md`);
	add('secret', m.workspace.secrets, () => 'src/+secrets.ts');
	add('group', m.groups, (name) => `src/app/${name}/+group.ts`);
	items.push({
		kind: 'workspace',
		name: 'workspace',
		description: '',
		href: source('src/+workspace.ts')
	});
	for (const [model, spec] of Object.entries(m.exposures)) {
		for (const name of Object.keys(spec.syncs ?? {}))
			items.push({
				kind: 'sync',
				name: `${model}.${name}`,
				description: 'Import, export or synchronize model data.',
				href: source(`src/data/model/${model}/+model.ts`)
			});
	}
	return items;
}
