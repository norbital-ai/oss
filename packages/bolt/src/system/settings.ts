import type { SchemaObject, SchemaSpec } from '@norbital-ai/store';

/** The native workspace settings singleton: no caller may create a second record. */
export const WORKSPACE_SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

/** Move the former display override out of private engine config once; never copy secret configuration. */
export function workspace_settings_objects(tables: SchemaSpec['tables']): readonly SchemaObject[] {
	if (tables['sys_workspace'] === undefined) return [];
	return [{
		id: 'backfill:sys_workspace.settings', rank: 'backfill', table: 'sys_workspace',
		deps: ['name', 'revision'], derived: true, drop: null,
		create: [
			`INSERT INTO sys_workspace (id, name, revision) SELECT '${WORKSPACE_SETTINGS_ID}', value::jsonb->>'name', 1 FROM sys_config WHERE key = 'workspace.identity' ON CONFLICT (id) DO NOTHING`,
			`INSERT INTO sys_workspace (id, revision) VALUES ('${WORKSPACE_SETTINGS_ID}', 1) ON CONFLICT (id) DO NOTHING`,
			"DELETE FROM sys_config WHERE key = 'workspace.identity'"
		]
	}];
}
