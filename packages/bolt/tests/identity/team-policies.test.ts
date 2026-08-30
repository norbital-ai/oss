import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import type { WorkspaceDefinition } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import * as Database from '../../src/runtime/facilities/database.js';
import * as Workspace from '../../src/runtime/workspace.js';

/** A minimal layer that exercises policy holding through AccessControl's public behavior. */
const accessFor = (definition: WorkspaceDefinition): AccessControl.Interface =>
	Effect.runSync(
		Effect.gen(function* () {
			return yield* AccessControl.Service;
		}).pipe(
			Effect.provide(
				AccessControl.layer.pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(
								Workspace.Service,
								Workspace.Service.of({ definition } as Workspace.Interface)
							),
							Layer.succeed(
								Database.Service,
								Database.Service.of({
									execute: () => Effect.die('database is not used by policy holding')
								})
							)
						)
					)
				)
			)
		)
	);

const definition = (teams: Readonly<Record<string, ReadonlyArray<string>>>): WorkspaceDefinition =>
	({
		collections: [],
		policies: ['employee', 'supervisor', 'hr_manager'].map((name) => ({
			name,
			capabilities: { apps: [name] }
		})),
		teams
	}) as unknown as WorkspaceDefinition;

const subject = (teamPath: ReadonlyArray<string>) => ({
	userId: 'u1',
	tenantId: 't1',
	policies: [],
	teamPath
});

const held = (
	teams: Readonly<Record<string, ReadonlyArray<string>>>,
	teamPath: ReadonlyArray<string>
): ReadonlyArray<string> =>
	[...accessFor(definition(teams)).capabilities(subject(teamPath)).apps].toSorted();

describe('policies held through a team', () => {
	it('holds what its team declares, folded on both sides', () => {
		expect(held({ 'HR Manager': ['employee', 'hr_manager'] }, ['hr manager'])).toEqual([
			'employee',
			'hr_manager'
		]);
	});

	it('uses descendant teams for scope but never inherits their policies', () => {
		expect(
			held({ Manager: ['supervisor'], Employee: ['employee'] }, ['Manager', 'Employee'])
		).toEqual(['supervisor']);
	});

	it('holds nothing when the subject belongs to no team', () => {
		expect(held({ Manager: ['supervisor'] }, [])).toEqual([]);
	});

	it('ignores undeclared teams and stale policy names without widening authority', () => {
		expect(held({}, ['Newly Created'])).toEqual([]);
		expect(held({ 'HR Manager': ['employee', 'payroll_admin_removed'] }, ['HR Manager'])).toEqual([
			'employee'
		]);
	});
});
