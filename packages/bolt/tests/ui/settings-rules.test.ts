import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layoutTeamHierarchy, type TeamNode } from '../../src/client/ui/settings/team-hierarchy.js';
import {
	invitationStatusAt,
	isActionableInvitation,
	memberLabel,
	sortAudit,
	sortMembers,
	type AuditRow,
	type InvitationRow,
	type MemberRow
} from '../../src/client/ui/settings/rows.js';

const member = (
	id: string,
	role: MemberRow['role'],
	name: string,
	email = `${id}@example.test`
): MemberRow => ({
	id,
	email,
	name,
	role,
	status: 'active'
});

const invitation = (overrides: Partial<InvitationRow> = {}): InvitationRow => ({
	id: 'inv-1',
	email: 'invite@example.test',
	role: 'basic',
	status: 'pending',
	...overrides
});

const NOW = new Date('2026-08-16T10:00:00.000Z');

describe('workspace member rules', () => {
	it('registers only the three host projections for URL-restored record details', () => {
		const source = readFileSync(
			new URL('../../src/client/ui/settings/workspace.svelte', import.meta.url),
			'utf8'
		);
		expect(source).toMatch(
			/\[MEMBERS_COLLECTION, INVITATIONS_COLLECTION, EVENTS_COLLECTION\]\.map\(/
		);
		expect(source).toMatch(
			/detailNavigation\?\.registerCollectionClient\(collectionName, \(\) => peopleClient\)/
		);
		expect(source).not.toContain('Object.keys(DEFINITIONS).map');
	});

	it('orders admins before managers before basic members, then by display name', () => {
		const ordered = sortMembers([
			member('u3', 'basic', 'Zoe'),
			member('u1', 'admin', 'Grace'),
			member('u4', 'manager', 'Alan'),
			member('u2', 'admin', 'Ada')
		]);
		expect(ordered.map(({ name }) => name)).toEqual(['Ada', 'Grace', 'Alan', 'Zoe']);
	});

	it('falls back to the address when a member has no name', () => {
		expect(memberLabel(member('u1', 'basic', '', 'nameless@example.test'))).toBe(
			'nameless@example.test'
		);
		expect(memberLabel(member('u2', 'basic', 'Ada'))).toBe('Ada');
	});
});

describe('envoy pairing workflow', () => {
	const source = readFileSync(
		new URL('../../src/client/ui/org/envoys-settings.svelte', import.meta.url),
		'utf8'
	);

	it('opens a dialog and polls host status for an asynchronously published QR code', () => {
		expect(source).toContain('<Dialog.Root open={pairingTarget !== undefined}');
		expect(source).toContain(
			'yield* Effect.promise(() => ownPairingOpen(envoy.name, envoy.transport))'
		);
		expect(source).toContain(
			"yield* runPairingRequest(envoy.name, envoy.transport, 'status').pipe("
		);
		expect(source).toContain('Effect.repeat({');
		expect(source).toContain('schedule: Schedule.spaced(750)');
		expect(source).toContain('Fiber.interrupt(fiber)');
		expect(source).toContain("connection?.state === 'disconnected'");
		expect(source).toContain('The transport did not open');
	});

	it('keeps one uncancellable host pair open per envoy across dialog close and reopen', () => {
		expect(source).toContain('const pairingOpens = new Map<string, Promise<void>>()');
		expect(source).toMatch(
			/const existing = pairingOpens\.get\(envoy\);\s*if \(existing !== undefined\) return existing;/
		);
		expect(source).toContain(
			"completion = Effect.runPromise(runPairingRequest(envoy, provider, 'pair')).finally(() => {"
		);
		expect(source).toMatch(
			/if \(pairingOpens\.get\(envoy\) !== completion\) return;\s*pairingOpens\.delete\(envoy\);\s*pairingBusy\[envoy\] = false;/
		);
		expect(source.match(/runPairingRequest\(envoy, provider, 'pair'\)/g)).toHaveLength(1);
		expect(source.match(/^\s*pairingBusy\[envoy\] = false/gm)).toHaveLength(1);
		expect(source).toContain("? 'Resume pairing'");
		expect(source).toContain('disabled={unpairingBusy[envoy.name] === true}');
	});

	it('keeps reconnect intent with its envoy when another pairing modal opens', () => {
		expect(source).toContain('let pairingReconnects = $state<Record<string, boolean>>({})');
		expect(source).toContain(
			'pairingReconnects[envoy.name] = connections[envoy.name]?.stored === true'
		);
		expect(source).toContain('{@const reconnecting = pairingReconnects[target.name] === true}');
		expect(source).not.toContain('let pairingReconnect = $state(');
	});

	it('keeps reconnect and non-WhatsApp modal copy provider-neutral', () => {
		expect(source).toContain('{#if reconnecting}');
		expect(source).toContain("{:else if target.transport === 'whatsapp'}");
		expect(source).toContain('The host is reopening the saved {target.transport} session.');
		expect(source).toContain('Follow any');
		expect(source).toMatch(/verification\s+steps its provider requests\./);
		expect(source).toContain('The transport could not open');
		expect(source).toContain('Envoy connected');
		expect(source).toContain("? 'Reopening the transport…'");
		expect(source).toContain(": 'Opening the transport…'");
		expect(source).toContain(
			': `Use this pairing code with ${target.transport}. It refreshes here if the provider rotates it.`}'
		);
	});
});

describe('invitation expiry', () => {
	it('reports a pending invitation past its deadline as expired', () => {
		expect(invitationStatusAt(invitation({ expiresAt: '2026-01-01T00:00:00.000Z' }), NOW)).toBe(
			'expired'
		);
		expect(invitationStatusAt(invitation({ expiresAt: '2099-01-01T00:00:00.000Z' }), NOW)).toBe(
			'pending'
		);
	});

	it('leaves a settled invitation alone whatever the clock says', () => {
		expect(
			invitationStatusAt(
				invitation({ status: 'accepted', expiresAt: '2020-01-01T00:00:00.000Z' }),
				NOW
			)
		).toBe('accepted');
		expect(invitationStatusAt(invitation({ status: 'revoked' }), NOW)).toBe('revoked');
	});

	it('treats an invitation with no deadline, or an unreadable one, as still pending', () => {
		expect(invitationStatusAt(invitation(), NOW)).toBe('pending');
		expect(invitationStatusAt(invitation({ expiresAt: 'not-a-date' }), NOW)).toBe('pending');
	});

	it('offers revoke and resend only while an invitation is genuinely pending', () => {
		expect(isActionableInvitation(invitation({ expiresAt: '2099-01-01T00:00:00.000Z' }), NOW)).toBe(
			true
		);
		expect(isActionableInvitation(invitation({ expiresAt: '2020-01-01T00:00:00.000Z' }), NOW)).toBe(
			false
		);
		expect(isActionableInvitation(invitation({ status: 'accepted' }), NOW)).toBe(false);
	});
});

describe('audit ordering', () => {
	const event = (id: string, at: string): AuditRow => ({
		id,
		action: 'member.role.changed',
		actor: 'Ada',
		at
	});

	it('reads newest first', () => {
		const ordered = sortAudit([
			event('a', '2026-08-01T00:00:00.000Z'),
			event('c', '2026-08-16T00:00:00.000Z'),
			event('b', '2026-08-10T00:00:00.000Z')
		]);
		expect(ordered.map(({ id }) => id)).toEqual(['c', 'b', 'a']);
	});

	it('sorts an unreadable timestamp last instead of throwing', () => {
		const ordered = sortAudit([
			event('bad', 'whenever'),
			event('good', '2026-08-16T00:00:00.000Z')
		]);
		expect(ordered.map(({ id }) => id)).toEqual(['good', 'bad']);
	});
});

describe('team hierarchy layout', () => {
	const team = (id: string, name: string, parentId?: string): TeamNode =>
		parentId === undefined ? { id, name } : { id, name, parentId };

	it('centres a parent over its children and stacks depth', () => {
		const { positions } = layoutTeamHierarchy([
			team('root', 'Company'),
			team('a', 'Engineering', 'root'),
			team('b', 'People', 'root')
		]);
		const at = (id: string) => positions.find((position) => position.id === id);
		expect(at('a')?.x).toBe(0);
		expect(at('b')?.x).toBe(300);
		expect(at('root')?.x).toBe(150);
		expect(at('root')?.y).toBe(0);
		expect(at('a')?.y).toBe(130);
	});

	it('keeps sibling subtrees from overlapping', () => {
		const { positions } = layoutTeamHierarchy([
			team('root', 'Company'),
			team('left', 'Left', 'root'),
			team('right', 'Right', 'root'),
			team('l1', 'L1', 'left'),
			team('l2', 'L2', 'left'),
			team('r1', 'R1', 'right')
		]);
		const x = (id: string) => positions.find((position) => position.id === id)?.x ?? 0;
		expect(x('l1')).toBeLessThan(x('l2'));
		expect(x('l2')).toBeLessThan(x('r1'));
		expect(x('left')).toBeLessThan(x('right'));
	});

	it('shows a team whose parent is missing rather than dropping it', () => {
		const { positions, edges } = layoutTeamHierarchy([team('orphan', 'Orphan', 'deleted-parent')]);
		expect(positions.map(({ id }) => id)).toEqual(['orphan']);
		expect(edges).toEqual([]);
	});

	it('terminates on a cycle instead of recursing forever', () => {
		const { positions } = layoutTeamHierarchy([team('a', 'A', 'b'), team('b', 'B', 'a')]);
		expect(positions).toHaveLength(2);
	});

	it('emits one edge per real parent link', () => {
		const { edges } = layoutTeamHierarchy([team('root', 'Root'), team('child', 'Child', 'root')]);
		expect(edges).toEqual([{ parentId: 'root', childId: 'child' }]);
	});

	it('is deterministic regardless of input order', () => {
		const teams = [team('root', 'Root'), team('a', 'Alpha', 'root'), team('b', 'Beta', 'root')];
		const forward = layoutTeamHierarchy(teams);
		const reversed = layoutTeamHierarchy([...teams].reverse());
		const asMap = (result: ReturnType<typeof layoutTeamHierarchy>) =>
			Object.fromEntries(
				result.positions.map((position) => [position.id, `${position.x}:${position.y}`])
			);
		expect(asMap(forward)).toEqual(asMap(reversed));
	});
});
