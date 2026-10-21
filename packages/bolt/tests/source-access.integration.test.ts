import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { HostIdentity } from '../src/shell/host.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { assignTeam, invite, issueKey } from '../src/engine/identity/members.ts';
import { decodeIdentity, loadPack, type Pack } from '../src/engine/write/pack.ts';
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
it.effect(
	'fresh schema keeps teams in source: no team table, no policy-assignment table, no team foreign key',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
				const t = Context.get(context, TestWorkspace);
				const [tables, fks] = yield* t.db.read([
					{
						text: "SELECT to_regclass('sys_team') IS NULL AND to_regclass('sys_assignment') IS NULL AS absent",
						params: []
					},
					{
						text: "SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'sys_user'::regclass AND pg_get_constraintdef(oid) LIKE '%(team)%'",
						params: []
					}
				]);
				expect(tables?.rows).toEqual([{ absent: true }]);
				expect(fks?.rows).toEqual([{ n: 0 }]);
			})
		)
);

it.effect(
	'membership grants exactly the authored team policies and a source descendant does not inherit them',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
				const t = Context.get(context, TestWorkspace),
					authorities = new Authorities(t.manifest, 'source-one');
				const sales = t.member([]),
					branch = t.member([]);
				yield* t.db.write({
					text: "UPDATE sys_user SET team = CASE WHEN id = $1 THEN 'sales-id' ELSE 'branch-id' END WHERE id IN ($1,$2)",
					params: [sales.id, branch.id]
				});
				const salesAuthority = yield* authorities.member(t.db, sales.id),
					branchAuthority = yield* authorities.member(t.db, branch.id);
				expect(salesAuthority?.policies).toEqual(['sales']);
				expect(salesAuthority?.teamTree).toEqual(['sales-id', 'branch-id']);
				expect(branchAuthority?.policies).toEqual([]);
				expect(branchAuthority?.actor).toMatchObject({
					teams: ['branch-id'],
					teamPath: ['Sales', 'Sales']
				});
				expect(
					(yield* new Authorities(
						{
							...t.manifest,
							teams: { ...source.teams, 'sales-id': { name: 'New label', policies: ['viewer'] } }
						},
						'source-two'
					).member(t.db, sales.id))?.policies
				).toEqual(['viewer']);
			})
		)
);

it.effect(
	'test members persist exact supplied source affiliations for native authority refresh',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
				const t = Context.get(context, TestWorkspace),
					authorities = new Authorities(t.manifest, 'source-one');
				const member = t.member(['sales'], { teams: ['sales-id'] });
				expect((yield* authorities.member(t.db, member.id))?.policies).toEqual(['sales']);
				expect((yield* authorities.member(t.db, member.id))?.actor).toMatchObject({
					teams: ['sales-id']
				});
			})
		)
);

it.effect('a stored handle no longer declared in source confers no membership or policies', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
			const t = Context.get(context, TestWorkspace),
				authorities = new Authorities(t.manifest, 'source-one');
			const impostor = t.member([]);
			yield* t.db.write({
				text: "UPDATE sys_user SET team = 'copied-label' WHERE id = $1",
				params: [impostor.id]
			});
			const authority = yield* authorities.member(t.db, impostor.id);
			expect(authority?.policies).toEqual([]);
			expect(authority?.actor).toMatchObject({ teams: [], teamPath: [] });
			yield* t.db.write({
				text: "UPDATE sys_user SET team = 'toString', revision = revision + 1 WHERE id = $1",
				params: [impostor.id]
			});
			expect((yield* authorities.member(t.db, impostor.id))?.actor).toMatchObject({
				teams: [],
				teamPath: []
			});
			const previewer = t.as(t.admin).authority.actor;
			if (previewer.kind !== 'member') throw new Error('admin must be a member');
			expect(yield* authorities.team(t.db, previewer, 'toString')).toBeNull();
		})
	)
);

it.effect(
	'native member affiliation, invitations and API keys admit existing source handles only',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
				const t = Context.get(context, TestWorkspace),
					h = Context.get(context, HostIdentity),
					authorities = new Authorities(t.manifest, 'source-one');
				const member = t.member([]),
					admin = t.as(t.admin).authority;
				expect(
					yield* Effect.flip(assignTeam(h, t.manifest, admin, member.id, 'Sales'))
				).toMatchObject({ code: 'notFound' });
				expect(
					yield* Effect.flip(
						invite(h, t.manifest, admin, { email: 'person@example.test', team: 'copied-label' })
					)
				).toMatchObject({ code: 'notFound' });
				expect(
					yield* Effect.flip(issueKey(h, t.manifest, admin, 'Invalid', 'copied-label'))
				).toMatchObject({ code: 'notFound' });
				expect(yield* assignTeam(h, t.manifest, admin, member.id, 'sales-id')).toBeNull();
				const key = yield* issueKey(h, t.manifest, admin, 'Catalogue', 'viewer-id');
				expect(key.id).toEqual(expect.any(String));
				expect((yield* authorities.apiKey(t.db, key.id))?.policies).toEqual(['viewer']);
				expect(
					(yield* new Authorities(
						{ ...t.manifest, teams: { ...source.teams, 'viewer-id': [] } },
						'revoked'
					).apiKey(t.db, key.id))?.policies
				).toEqual([]);
			})
		)
);

it.effect('an undeclared team handle on sys_user is refused and leaves the member unchanged', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
			const t = Context.get(context, TestWorkspace),
				h = Context.get(context, HostIdentity);
			const member = t.member([]),
				admin = t.as(t.admin).authority;
			expect(yield* assignTeam(h, t.manifest, admin, member.id, 'sales-id')).toBeNull();
			for (const handle of ['Sales', 'nope', 'toString'])
				expect(
					yield* Effect.flip(assignTeam(h, t.manifest, admin, member.id, handle))
				).toMatchObject({ code: 'notFound' });
			const [row] = yield* t.db.read([
				{ text: 'SELECT team FROM sys_user WHERE id = $1', params: [member.id] }
			]);
			expect(row?.rows).toEqual([{ team: 'sales-id' }]);
		})
	)
);

it.effect(
	'policy recipient fan-out follows the direct source team and preserves one inbox notice per member',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
				const t = Context.get(context, TestWorkspace);
				const sales = t.member([]),
					branch = t.member([]);
				yield* t.db.write({
					text: "UPDATE sys_user SET team = CASE WHEN id = $1 THEN 'sales-id' ELSE 'branch-id' END WHERE id IN ($1,$2)",
					params: [sales.id, branch.id]
				});
				const c = new Chain();
				noticeInsert(
					c,
					'n',
					[
						{
							id: 'source-notice',
							to: {
								channel: 'inbox',
								recipients: [{ policy: 'sales' }, { team: 'sales-id' }, { user: sales.id }]
							},
							title: 'Source holders',
							once: 'source-notice'
						}
					],
					t.clock.now(),
					'true',
					t.manifest.teams
				);
				yield* t.db.write(c.sql('1 AS done'));
				const [rows] = yield* t.db.read([
					{ text: 'SELECT member FROM sys_notification WHERE member = $1', params: [sales.id] }
				]);
				expect(rows?.rows).toEqual([{ member: sales.id }]);
				const [absent] = yield* t.db.read([
					{ text: 'SELECT member FROM sys_notification WHERE member = $1', params: [branch.id] }
				]);
				expect(absent?.rows).toEqual([]);
				const signedUp = t.member([]);
				yield* t.db.write({
					text: 'UPDATE sys_user SET signup = true WHERE id = $1',
					params: [signedUp.id]
				});
				const origin = new Chain();
				noticeInsert(
					origin,
					'n',
					[
						{
							id: 'signup-notice',
							to: { policy: 'viewer' },
							title: 'Source signup holders',
							once: 'signup-notice'
						}
					],
					t.clock.now(),
					'true',
					t.manifest.teams,
					['viewer']
				);
				yield* t.db.write(origin.sql('1 AS done'));
				const [originRecipients] = yield* t.db.read([
					{ text: 'SELECT member FROM sys_notification WHERE member = $1', params: [signedUp.id] }
				]);
				expect(originRecipients?.rows).toEqual([{ member: signedUp.id }]);
			})
		)
);

it.effect(
	'self-signup policies stay source-owned and never spread to invited external members',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
				const t = Context.get(context, TestWorkspace);
				const signup = t.member([], { external: true }),
					invited = t.member([], { external: true });
				yield* t.db.write({
					text: 'UPDATE sys_user SET signup = true WHERE id = $1',
					params: [signup.id]
				});
				const current = {
					...t.manifest,
					workspace: { ...t.manifest.workspace, signup: { via: ['email'], policies: ['viewer'] } }
				} satisfies EngineManifest;
				const readers = new Authorities(current, 'signup-one');
				expect((yield* readers.member(t.db, signup.id))?.policies).toEqual(['viewer']);
				expect((yield* readers.member(t.db, invited.id))?.policies).toEqual([]);
				expect(
					(yield* new Authorities(
						{
							...current,
							workspace: { ...current.workspace, signup: { via: ['email'], policies: [] } }
						},
						'signup-two'
					).member(t.db, signup.id))?.policies
				).toEqual([]);
			})
		)
);

it.effect(
	'member seed rows reference source handles and cannot introduce teams or policy assignments',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
				const t = Context.get(context, TestWorkspace);
				for (const rows of [
					{ sys_team: [] },
					{ sys_assignment: [] },
					{ sys_user: [{ id: 'bad', team: 'Sales' }] },
					{ sys_user: [{ id: 'bad', team: 'toString' }] }
				])
					expect(() => decodeIdentity(source, rows)).toThrow();
				const seeded = Context.get(
					yield* Layer.build(TestWorkspace.layer({ manifest: source })),
					TestWorkspace
				);
				const pack: Pack = {
					dir: '',
					rows: { sys_user: [{ id: 'seed-user', name: 'Seeded', team: 'viewer-id' }] },
					meta: {
						format: 1,
						name: 'base',
						hash: 'source-members',
						start: [],
						rows: { sys_user: 1 },
						assets: []
					}
				};
				expect(yield* loadPack(seeded.db, seeded.manifest, pack, t.clock.now())).toBe(true);
				expect(
					(yield* new Authorities(seeded.manifest, 'seeded').member(seeded.db, 'seed-user'))
						?.policies
				).toEqual(['viewer']);
			})
		)
);

it.effect(
	'a release removing a source team plans no schema change and its members hold nothing',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: source }));
				const h = Context.get(context, HostIdentity);
				const isolated = Context.get(
					yield* Layer.build(TestWorkspace.layer({ manifest: source })),
					TestWorkspace
				);
				const member = isolated.member([]),
					admin = isolated.as(isolated.admin).authority;
				yield* assignTeam(
					{ ...h, db: isolated.db },
					isolated.manifest,
					admin,
					member.id,
					'viewer-id'
				);
				const removed = { ...isolated.manifest, teams: {} };
				expect(plan(yield* readApplied(isolated.db), removed).steps).toEqual([]);
				expect(
					(yield* new Authorities(isolated.manifest, 'source').member(isolated.db, member.id))
						?.policies
				).toEqual(['viewer']);
				expect(
					(yield* new Authorities(removed, 'removed').member(isolated.db, member.id))?.actor
				).toMatchObject({ teams: [], teamPath: [] });
			})
		)
);
