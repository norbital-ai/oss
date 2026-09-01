import { describe, expect, it } from 'vitest';
import {
	renderClientDeclaration,
	renderCollectionTypes,
	renderWorkspaceTypes
} from '../../src/compiler/workspace-build.js';

describe('generated declarative mutation types', () => {
	it('carries a uniquely reversed child foreign key onto a differently named many relation', () => {
		const rendered = renderWorkspaceTypes([
			{
				name: 'account_contacts',
				source: 'accounts',
				target: 'contacts',
				cardinality: 'many'
			},
			{
				name: 'contact_account',
				source: 'contacts',
				target: 'accounts',
				cardinality: 'one',
				cascade: true,
				from: { collection: 'contacts', column: 'account_id' },
				to: { collection: 'accounts', column: 'id' }
			}
		]);

		expect(rendered).toContain(
			'readonly "account_contacts": { readonly target: "contacts"; readonly cardinality: "many"; readonly column: "account_id"; readonly parentColumn: "id"; readonly cascade: true }'
		);
	});

	it('does not guess when two reversed child foreign keys are possible', () => {
		const rendered = renderWorkspaceTypes([
			{
				name: 'person_links',
				source: 'people',
				target: 'links',
				cardinality: 'many'
			},
			{
				name: 'link_from',
				source: 'links',
				target: 'people',
				cardinality: 'one',
				from: { collection: 'links', column: 'from_id' },
				to: { collection: 'people', column: 'id' }
			},
			{
				name: 'link_to',
				source: 'links',
				target: 'people',
				cardinality: 'one',
				from: { collection: 'links', column: 'to_id' },
				to: { collection: 'people', column: 'id' }
			}
		]);

		expect(rendered).toContain(
			'readonly "person_links": { readonly target: "links"; readonly cardinality: "many"; readonly column: never; readonly parentColumn: never; readonly cascade: false }'
		);
	});

	it('carries a non-id parent join so mutation types can exclude the unsupported edge', () => {
		const rendered = renderWorkspaceTypes([
			{
				name: 'external_children',
				source: 'parents',
				target: 'children',
				cardinality: 'many',
				from: { collection: 'parents', column: 'external_key' },
				to: { collection: 'children', column: 'parent_external_key' }
			}
		]);

		expect(rendered).toContain(
			'readonly "external_children": { readonly target: "children"; readonly cardinality: "many"; readonly column: "parent_external_key"; readonly parentColumn: "external_key"; readonly cascade: false }'
		);
	});

	it('carries the exact mutation graph into the declarative collection client', () => {
		const rendered = renderClientDeclaration([], '/workspace');

		expect(rendered).toContain('type TenantCollections = CollectionRegistryFor<WorkspaceSchema>');
		expect(rendered).toContain("CollectionClient<TenantCollections>['db'][N]");
		expect(rendered).toContain('export type WorkspaceMutation');
	});

	it('carries authored automation schemas into the generated per-name client surface', () => {
		const rendered = renderClientDeclaration([], '/workspace', [
			'/workspace/src/automations/+rebuild.ts'
		]);

		expect(rendered).toContain('type AutomationRegistry = {');
		expect(rendered).toContain(
			'readonly "rebuild": typeof import("../../src/automations/+rebuild.js").default'
		);
		expect(rendered).toContain('readonly automations: AutomationClientApi<AutomationRegistry>');
	});

	it('keeps the generated authored client free of private runtime capabilities', () => {
		const rendered = renderClientDeclaration([], '/workspace');

		expect(rendered).toContain('PublicPlatformSchema');
		expect(rendered).toContain('type PublicCollectionName = keyof Collections & string');
		expect(rendered).not.toContain('SystemClientApi');
		expect(rendered).not.toContain('WorkspaceClientRuntime');
		expect(rendered).not.toContain('readonly system:');
		expect(rendered).not.toContain('readonly runtime:');
	});

	it('renders the representation contract', () => {
		const rendered = renderCollectionTypes('accounts');

		expect(rendered).toContain(
			'export type RepresentationProps = { readonly record: Row | null; close(): void }'
		);
	});
});
