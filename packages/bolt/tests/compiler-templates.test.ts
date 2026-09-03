import { describe, expect, it } from 'vitest';
import { app, collection, field, workspace } from '../src/authoring/workspace-schema.js';
import { generateWorkspaceTypes } from '../src/compiler/compiler.js';

describe('compiler template generation', () => {
	it('sorts generated collection and application unions independently of discovery order', () => {
		const definition = workspace({
			name: 'template',
			version: '1',
			collections: [
				collection({ name: 'z', fields: {} }),
				collection({ name: 'a', fields: { name: field.string() } })
			],
			apps: [
				app({ name: 'z-app/details', label: 'Z details' }),
				app({ name: 'a-app', label: 'A' })
			],
			policies: [],
			automations: [],
			envoys: [],
			integrations: [],
			prompt: 'You are the test workspace agent.',
			tools: [],
			skills: [],
			requiredFacilities: []
		});
		const output = generateWorkspaceTypes(definition);
		expect(output).toContain('export type CollectionName = "a" | "z"');
		expect(output).toContain('export type AppName = "a-app" | "z-app" | "z-app/details"');
	});
});
