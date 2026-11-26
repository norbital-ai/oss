import type { SchemaObject, SchemaSpec } from '@norbital-ai/store';

/** The native workspace settings singleton: no caller may create a second record. */
export const WORKSPACE_SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

/** The settings singleton exists in every workspace. */
export function workspace_settings_objects(tables: SchemaSpec['tables']): readonly SchemaObject[] {
	if (tables['sys_workspace'] === undefined) return [];
	return [{
		id: 'backfill:sys_workspace.settings', rank: 'backfill', table: 'sys_workspace',
		deps: ['name', 'revision'], derived: true, drop: null,
		create: [
			`INSERT INTO sys_workspace (id, revision) VALUES ('${WORKSPACE_SETTINGS_ID}', 1) ON CONFLICT (id) DO NOTHING`
		]
	}];
}
