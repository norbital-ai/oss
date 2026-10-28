import { describe, expect, it } from '@effect/vitest';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { approvable, ownedEdges } from '../src/engine/approvals/lock.ts';

const model = (description: string): EngineManifest['models'][string] => ({
	description,
	label: 'name',
	fields: { name: { kind: 'text' } }
});
const manifest = (
	models: EngineManifest['models'],
	relationships: EngineManifest['relationships'],
	policies: EngineManifest['policies'] = {}
): EngineManifest => ({
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models,
	relationships,
	exposures: Object.fromEntries(
		Object.keys(models).map((name): [string, EngineManifest['exposures'][string]] => [
			name,
			{ read: { [name]: { fields: 'all' } }, delete: {} }
		])
	),
	policies,
	integrations: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
});

describe('approval relationship traversal', () => {
	it('finds inverse-less owned links and each physical polymorphic FK column', () => {
		const m = manifest(
			{ first: model('First parent'), second: model('Second parent'), children: model('Children') },
			{
				'children.parent': { to: 'first', owned: true },
				'children.owner': { to: ['first', 'second'], owned: true }
			}
		);
		expect(ownedEdges(m, catalogOf(m))).toEqual([
			['children', 'parent', 'first'],
			['children', 'owner__first', 'first'],
			['children', 'owner__second', 'second']
		]);
	});

	it('excludes owned links whose child or target no longer exists in the native catalog', () => {
		const m = manifest(
			{
				parent: model('Parent'),
				kept: model('Kept child'),
				removed_child: model('Removed child'),
				removed_parent: model('Removed parent'),
				orphan: model('Former child of removed parent')
			},
			{
				'kept.parent': { to: 'parent', owned: true },
				'removed_child.parent': { to: 'parent', owned: true },
				'orphan.parent': { to: 'removed_parent', owned: true }
			}
		);
		const reduced = manifest(
			{ parent: model('Parent'), kept: model('Kept child'), orphan: model('Unlinked child') },
			{ 'kept.parent': { to: 'parent', owned: true } }
		);
		expect(ownedEdges(m, catalogOf(reduced))).toEqual([['kept', 'parent', 'parent']]);
	});

	it('includes inverse-less non-owned references and terminates a cyclic graph', () => {
		const m = manifest(
			{
				root: model('Approval root'),
				child: model('Referenced child'),
				leaf: model('Referenced leaf'),
				unrelated: model('Unrelated')
			},
			{
				'child.root': { to: 'root', onDelete: 'restrict' },
				'root.child': { to: 'child', onDelete: 'restrict' },
				'leaf.child': { to: 'child', onDelete: 'restrict' }
			},
			{
				requester: {
					description: 'Requests root deletion: its delete check may approve',
					grants: { root: { read: true, delete: { check: true } } }
				}
			}
		);
		expect([...approvable(m, catalogOf(m))].sort()).toEqual(['child', 'leaf', 'root']);
	});
});
