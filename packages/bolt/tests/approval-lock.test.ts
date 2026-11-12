import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { catalog_of } from '../src/engine/access/pred.ts';
import { approvable, heldModels, lockPieces } from '../src/engine/approvals/lock.ts';
import { Chain } from '../src/engine/write/sql.ts';
import { member } from './write-fixture.ts';
import type { Catalog } from '@norbital-ai/store';
import { DbError } from '../src/engine/errors.ts';

it.effect('reports a database failure while loading held approval models', () =>
	Effect.gen(function* () {
		const outage = DbError.make('08006', 'database unavailable');
		expect(yield* Effect.result(heldModels({ rows: () => Effect.fail(outage) }))).toMatchObject({
			_tag: 'Failure',
			failure: outage
		});
		expect(
			yield* heldModels({ rows: () => Effect.fail(DbError.make('42P01', 'not yet planned')) })
		).toEqual(new Set());
	})
);

const model = (description: string): EngineManifest['models'][string] => ({
	description,
	record_label: 'record.name',
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
			{ outputs: { default: { [name]: { fields: 'all' } } }, delete: {} }
		])
	),
	policies,
	integrations: {},
	teams: {},
	automations: {},

	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
});

const locked_edges = (m: EngineManifest, catalog: Catalog) => {
 const statement = new Chain();
 lockPieces(m, catalog, statement, member, 'allp');
 const sql = statement.sql('1').text;
 const touch = sql.slice(sql.indexOf('ap_touch AS'), sql.indexOf('ap_hit AS'));
 // the relationship names are manifest constants: literals in the statement text, never per-act parameters
 const edges = [...touch.matchAll(/SELECT '([^']+)'::text, image\.j ->> '([^']+)' FROM allp[\s\S]*?WHERE c = '([^']+)' AND/g)];
 return edges.map((match) => [match[3], match[2], match[1]]);
};

describe('approval relationship traversal', () => {
	it('finds inverse-less owned links and each physical polymorphic FK column', () => {
		const m = manifest(
			{ first: model('First parent'), second: model('Second parent'), children: model('Children') },
			{
				'children.parent': { to: 'first', owned: true },
				'children.owner': { to: ['first', 'second'], owned: true }
			}
		);
		expect(locked_edges(m, catalog_of(m))).toEqual([
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
		expect(locked_edges(m, catalog_of(reduced))).toEqual([['kept', 'parent', 'parent']]);
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
				'child.root': { to: 'root', on_delete: 'restrict' },
				'root.child': { to: 'child', on_delete: 'restrict' },
				'leaf.child': { to: 'child', on_delete: 'restrict' }
			},
			{
				requester: {
					description: 'Requests root deletion: its delete check may approve',
					grants: { root: { outputs: { default: true }, delete: { verdict: true } } }
				}
			}
		);
		expect([...approvable(m, catalog_of(m))].sort()).toEqual(['child', 'leaf', 'root']);
	});
});
