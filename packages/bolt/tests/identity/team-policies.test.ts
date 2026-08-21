import { describe, expect, it, vi } from 'vitest';
import { policiesHeld } from '../../src/runtime/access/access-control.js';
import type { WorkspaceDefinition } from '../../src/authoring/workspace-schema.js';

/**
 * A workspace declaring three policies and a team map over them.
 *
 * Only the two fields `policiesHeld` reads are real; everything else a `WorkspaceDefinition`
 * carries is irrelevant to the question and would only obscure it.
 */
const definition = (teams: Readonly<Record<string, ReadonlyArray<string>>>): WorkspaceDefinition =>
	({
		policies: [{ name: 'employee' }, { name: 'supervisor' }, { name: 'hr_manager' }],
		teams
	}) as unknown as WorkspaceDefinition;

const subject = (teamPath: ReadonlyArray<string>) =>
	({ userId: 'u1', tenantId: 't1', teamPath }) as never;

describe('policies held through a team', () => {
	it('holds what its team declares, folded on both sides', () => {
		const held = policiesHeld(
			definition({ 'HR Manager': ['employee', 'hr_manager'] }),
			// The row's name and the map's key differ in case, which is the ordinary state of affairs
			// once a name has been through a dashboard, an import and a seed file.
			subject(['hr manager'])
		);
		expect([...held].toSorted()).toEqual(['employee', 'hr_manager']);
	});

	it('unions every team on the path, so an inheriting team holds what sits beneath it', () => {
		const held = policiesHeld(
			definition({ Manager: ['supervisor'], Employee: ['employee'] }),
			subject(['Manager', 'Employee'])
		);
		expect([...held].toSorted()).toEqual(['employee', 'supervisor']);
	});

	it('holds nothing when the subject belongs to no team', () => {
		expect(policiesHeld(definition({ Manager: ['supervisor'] }), subject([])).size).toBe(0);
	});

	it('holds nothing for a team the release does not declare, and says nothing about it', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			// An operator can create a team before the code that gives it authority ships. That is the
			// ordinary case, not a fault, so it is silent.
			expect(policiesHeld(definition({}), subject(['Newly Created'])).size).toBe(0);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	/**
	 * The case this whole tolerance exists for: a team names a policy that has since been renamed or
	 * deleted. The name is bogus and is dropped; the request is *not* refused, and the rest of the
	 * team's authority still resolves. A workspace must not fall over on a stale string.
	 */
	it('drops a policy the release no longer declares, keeps the rest, and warns once', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const workspace = definition({ 'HR Manager': ['employee', 'payroll_admin_removed'] });
			const held = policiesHeld(workspace, subject(['HR Manager']));
			expect([...held]).toEqual(['employee']);
			expect(warn).toHaveBeenCalledTimes(1);
			const [line] = warn.mock.calls[0] as [string];
			expect(line).toContain('HR Manager');
			expect(line).toContain('payroll_admin_removed');

			// Deduped across calls: this runs on the authorization path, so one stale name must be one
			// line and not one line per request.
			policiesHeld(workspace, subject(['HR Manager']));
			policiesHeld(workspace, subject(['HR Manager']));
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});
