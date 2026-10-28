import { expect } from '@effect/vitest';
import { Effect } from 'effect';
import { HostIdentity } from '../src/shell/host.ts';
import { layer, TestWorkspace } from '../src/test/index.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { assignTeam, invite, issueKey } from '../src/engine/identity/members.ts';
import { decodeIdentity, loadPack, sourceOf, type Pack } from '../src/engine/write/pack.ts';
import { Chain, noticeInsert } from '../src/engine/write/sql.ts';
import { manifest } from './catalogue-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { plan, readApplied } from '../src/engine/schema/plan.ts';

const source = {
	...manifest,
	teams: {
		'sales-id': { name: 'Sales', policies: ['sales'] },
		'branch-id': { name: 'Sales', parent: 'sales-id', policies: [] },
		'viewer-id': ['viewer']
	}
};

// One workspace: every case creates its own members, so no case reads another's rows. The seed case runs first:
// a pack loads only into a database with no member rows.
layer(TestWorkspace.layer({ manifest: source }))('source-owned teams', (it) => {
	it.effect('member seed rows reference source handles and cannot introduce teams or policy assignments', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			for (const rows of [
				{ sys_team: [] },
				{ sys_assignment: [] },
				{ sys_user: [{ id: 'bad', team: 'Sales' }] },
				{ sys_user: [{ id: 'bad', team: 'toString' }] }
			])
				expect(() => decodeIdentity(source, rows)).toThrow();
			const pack: Pack = {
				dir: '',
				rows: { sys_user: [{ id: 'seed-user', name: 'Seeded', team: 'viewer-id' }] },
				meta: { format: 1, name: 'base', hash: 'source-members', start: [], rows: { sys_user: 1 }, assets: [] }
			};
			expect(yield* loadPack(t.db, t.manifest, sourceOf(pack), t.clock.now())).toBe(true);
			expect((yield* new Authorities(t.manifest, 'seeded').member(t.db, 'seed-user'))?.policies).toEqual(['viewer']);
		})
	);

	it.effect('membership grants exactly the source policies; descendants, stale and removed handles hold nothing', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace,
				authorities = new Authorities(t.manifest, 'source-one');
			const sales = t.member([]),
				branch = t.member([]),
				impostor = t.member([]);
			yield* t.db.write({
				text: "UPDATE sys_user SET team = CASE WHEN id = $1 THEN 'sales-id' WHEN id = $2 THEN 'branch-id' ELSE 'toString' END WHERE id IN ($1,$2,$3)",
				params: [sales.id, branch.id, impostor.id]
			});
			const salesAuthority = yield* authorities.member(t.db, sales.id),
				branchAuthority = yield* authorities.member(t.db, branch.id);
			expect(salesAuthority?.policies).toEqual(['sales']);
			expect(salesAuthority?.teamTree).toEqual(['sales-id', 'branch-id']);
			expect(branchAuthority?.policies).toEqual([]);
			expect(branchAuthority?.actor).toMatchObject({ teams: ['branch-id'], teamPath: ['Sales', 'Sales'] });
			expect((yield* authorities.member(t.db, impostor.id))?.actor).toMatchObject({ teams: [], teamPath: [] });
			const previewer = t.as(t.admin).authority.actor;
			if (previewer.kind !== 'member') throw new Error('admin must be a member');
			expect(yield* authorities.team(t.db, previewer, 'toString')).toBeNull();
			// a release relabelling or removing a team plans no schema change and re-derives authority
			expect(
				(yield* new Authorities(
					{ ...t.manifest, teams: { ...source.teams, 'sales-id': { name: 'New label', policies: ['viewer'] } } },
					'source-two'
				).member(t.db, sales.id))?.policies
			).toEqual(['viewer']);
			const removed = { ...t.manifest, teams: {} };
			expect((yield* plan(yield* readApplied(t.db), removed)).steps).toEqual([]);
			expect((yield* new Authorities(removed, 'removed').member(t.db, sales.id))?.actor).toMatchObject({
				teams: [],
				teamPath: []
			});
			const member = t.member(['sales'], { teams: ['sales-id'] });
			expect((yield* authorities.member(t.db, member.id))?.actor).toMatchObject({ teams: ['sales-id'] });
		})
	);

	it.effect('affiliation, invitations and API keys admit source handles only', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace,
				h = yield* HostIdentity,
				authorities = new Authorities(t.manifest, 'source-one');
			const member = t.member([]),
				admin = t.as(t.admin).authority;
			expect(yield* assignTeam(h, t.manifest, admin, member.id, 'sales-id')).toBeNull();
			for (const handle of ['Sales', 'toString'])
				expect(yield* Effect.flip(assignTeam(h, t.manifest, admin, member.id, handle))).toMatchObject({
					code: 'notFound'
				});
			const [row] = yield* t.db.read([{ text: 'SELECT team FROM sys_user WHERE id = $1', params: [member.id] }]);
			expect(row?.rows).toEqual([{ team: 'sales-id' }]);
			expect(
				yield* Effect.flip(invite(h, t.manifest, admin, { email: 'person@example.test', team: 'copied-label' }))
			).toMatchObject({ code: 'notFound' });
			expect(yield* Effect.flip(issueKey(h, t.manifest, admin, 'Invalid', 'copied-label'))).toMatchObject({
				code: 'notFound'
			});
			const key = yield* issueKey(h, t.manifest, admin, 'Catalogue', 'viewer-id');
			expect((yield* authorities.apiKey(t.db, key.id))?.policies).toEqual(['viewer']);
			expect(
				(yield* new Authorities({ ...t.manifest, teams: { ...source.teams, 'viewer-id': [] } }, 'revoked').apiKey(
					t.db,
					key.id
				))?.policies
			).toEqual([]);
		})
	);

	it.effect('notice fan-out follows the direct source team and signup policies, one notice per member', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const sales = t.member([]),
				branch = t.member([]),
				signedUp = t.member([]);
			yield* t.db.write({
				text: "UPDATE sys_user SET team = CASE WHEN id = $1 THEN 'sales-id' ELSE 'branch-id' END WHERE id IN ($1,$2)",
				params: [sales.id, branch.id]
			});
			yield* t.db.write({ text: 'UPDATE sys_user SET signup = true WHERE id = $1', params: [signedUp.id] });
			const c = new Chain();
			noticeInsert(
				c,
				'n',
				[
					{
						id: 'source-notice',
						to: [{ policy: 'sales' }, { team: 'sales-id' }, { user: sales.id }],
						title: 'Source holders',
						attachments: [],
						once: 'source-notice'
					}
				],
				t.clock.now(),
				'true',
				t.manifest.teams
			);
			yield* t.db.write(c.sql('1 AS done'));
			const origin = new Chain();
			noticeInsert(
				origin,
				'n',
				[{ id: 'signup-notice', to: [{ policy: 'viewer' }], title: 'Signup holders', attachments: [], once: 'signup-notice' }],
				t.clock.now(),
				'true',
				t.manifest.teams,
				['viewer']
			);
			yield* t.db.write(origin.sql('1 AS done'));
			const [rows] = yield* t.db.read([
				{
					text: 'SELECT member FROM sys_notification WHERE member IN ($1,$2,$3) ORDER BY member',
					params: [sales.id, branch.id, signedUp.id]
				}
			]);
			expect(rows?.rows).toEqual([{ member: sales.id }, { member: signedUp.id }].sort((a, b) => a.member.localeCompare(b.member)));
		})
	);

	it.effect('self-signup policies stay source-owned and never spread to invited external members', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const signup = t.member([], { external: true }),
				invited = t.member([], { external: true });
			yield* t.db.write({ text: 'UPDATE sys_user SET signup = true WHERE id = $1', params: [signup.id] });
			const current = {
				...t.manifest,
				workspace: { ...t.manifest.workspace, signup: { via: ['email'], policies: ['viewer'] } }
			} satisfies EngineManifest;
			const readers = new Authorities(current, 'signup-one');
			expect((yield* readers.member(t.db, signup.id))?.policies).toEqual(['viewer']);
			expect((yield* readers.member(t.db, invited.id))?.policies).toEqual([]);
			expect(
				(yield* new Authorities(
					{ ...current, workspace: { ...current.workspace, signup: { via: ['email'], policies: [] } } },
					'signup-two'
				).member(t.db, signup.id))?.policies
			).toEqual([]);
		})
	);
});

