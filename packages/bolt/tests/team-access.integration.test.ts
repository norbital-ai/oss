import { expect } from '@effect/vitest';
import { Effect } from 'effect';
import type { Json } from '../src/decl/values.ts';
import { canApprove } from '../src/engine/approvals/route.ts';
import { Automations, HostIdentity } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { assign_team, invite, issueKey } from '../src/engine/identity/members.ts';
import { decode_identity, load_pack, source_of, type Pack } from '../src/engine/write/pack.ts';
import { Chain, noticeInsert } from '../src/engine/write/sql.ts';
import { manifest } from './catalogue-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { layer } from '../../bolt-cli/src/test/effect.ts';
import { teams_sql } from './support/teams.ts';

const source = manifest;
const TEAMS = [
	{ id: 'sales-id', name: 'Sales', policies: ['sales'] },
	{ id: 'branch-id', name: 'Sales', parent: 'sales-id', policies: [] },
	{ id: 'viewer-id', name: 'Viewers', policies: ['viewer'] }
];
const POLICIES = Object.fromEntries(TEAMS.map((team) => [team.id, team.policies]));

// One workspace: every case creates its own members, so no case reads another's rows. The seed case runs first:
// a pack loads only into a database with no team or member rows, and its teams are the workspace's.
layer(TestWorkspace.layer({ manifest: source }))('team rows', (it) => {
	it.effect(
		'a pack carries its teams: a member names one of them, a team holds declared policies under a parent of the pack',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				for (const rows of [
					{ sys_assignment: [] },
					{ sys_user: [{ id: 'bad', team: 'sales-id' }] },
					{ sys_team: [{ id: 'a', name: 'A', policies: ['undeclared'] }] },
					{ sys_team: [{ id: 'a', name: 'A', parent: 'toString' }] },
					{ sys_team: [{ id: 'a', name: 'A', parent: 'b' }, { id: 'b', name: 'B', parent: 'a' }] }
				])
					expect(() => decode_identity(source, rows)).toThrow();
				const pack: Pack = {
					dir: '',
					rows: {
						sys_team: TEAMS,
						sys_user: [{ id: 'seed-user', name: 'Seeded', team: 'viewer-id' }]
					},
					meta: {
						format: 1,
						name: 'base',
						hash: 'team-members',
						start: [],
						rows: { sys_team: TEAMS.length, sys_user: 1 },
						assets: []
					}
				};
				expect(yield* load_pack(t.db, t.manifest, source_of(pack), t.clock.now())).toBe(true);
				expect(
					(yield* new Authorities(t.manifest, 'seeded').member(t.db, 'bootstrap', 'seed-user'))?.policies
				).toEqual(['viewer']);
			})
	);

	it.effect(
		'membership grants exactly the team policies; a descendant holds nothing of its parent',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace,
					authorities = new Authorities(t.manifest, 'source-one');
				const sales = t.member([]),
					branch = t.member([]),
					unaffiliated = t.member([]);
				yield* t.db.write({
					text: "UPDATE sys_user SET team = CASE WHEN id = $1 THEN 'sales-id' ELSE 'branch-id' END WHERE id IN ($1,$2)",
					params: [sales.id, branch.id]
				});
				const salesAuthority = yield* authorities.member(t.db, 'bootstrap', sales.id),
					branchAuthority = yield* authorities.member(t.db, 'bootstrap', branch.id);
				expect(salesAuthority?.policies).toEqual(['sales']);
				expect(salesAuthority?.teamTree).toEqual(['sales-id', 'branch-id']);
				expect(branchAuthority?.policies).toEqual([]);
				expect(branchAuthority?.actor).toMatchObject({
					teams: ['branch-id'],
					team_path: ['Sales', 'Sales']
				});
				expect((yield* authorities.member(t.db, 'bootstrap', unaffiliated.id))?.actor).toMatchObject({
					teams: [],
					team_path: []
				});
				const previewer = (yield* t.as(t.admin)).authority.actor;
				if (previewer.kind !== 'member') throw new Error('admin must be a member');
				expect(yield* authorities.team(t.db, previewer, 'toString')).toBeNull();
				const member = t.member(['sales'], { teams: ['sales-id'] });
				expect((yield* authorities.member(t.db, 'bootstrap', member.id))?.actor).toMatchObject({
					teams: ['sales-id']
				});
			})
	);

	it.effect('resolves concurrent function grants, bundle edits, local-date expiry and revocation on the same cached member', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const reader = t.member([], { teams: ['branch-id'] });
			yield* t.as(reader);
			for (const query of [
				'CREATE TABLE grants (member text, team text, until date)',
				'CREATE TABLE role_assignments (member text, role text, until date)',
				'CREATE TABLE role_levels (role text, team text)'
			]) yield* t.db.write({ text: query, params: [] });
			const roles = { model: 'grants', bundles: { assignments: 'role_assignments', levels: 'role_levels' } };
			const current = { ...source, workspace: { ...source.workspace, tz: 'Asia/Singapore', memberships: roles } };
			const authorities = new Authorities(current, 'bound', { remember: true });
			const member = () => authorities.member(t.db, 'bootstrap', reader.id);
			const write = (text: string, params: string[] = []) => t.db.write({ text, params });
			yield* write("INSERT INTO grants VALUES ($1,'viewer-id',null)", [reader.id]);
			yield* write("INSERT INTO role_assignments VALUES ($1,'managers','2026-11-20')", [reader.id]);
			yield* write("INSERT INTO role_levels VALUES ('managers','sales-id')");
			t.clock.set('2026-11-20T15:59:59Z');
			const before = yield* member();
			expect(before?.actor).toMatchObject({ teams: ['branch-id','sales-id','viewer-id'], admin: false });
			expect(before?.policies).toEqual(['sales', 'viewer']);
			const notice = new Chain();
			noticeInsert(notice, 'to_team', [{ id: 'second-team', to: [{ team: 'sales-id' }, { policy: 'sales' }],
				title: 'For this role', once: 'second-team', attachments: [] }], t.clock.now(), 'true', POLICIES, [], current.workspace);
			yield* t.db.write(notice.sql('1 AS done'));
			const [delivered] = yield* t.db.read([{ text: 'SELECT member FROM sys_notification WHERE id=$1',
				params: ['second-team:' + reader.id] }]);
			expect(delivered?.rows).toEqual([{ member: reader.id }]);
			if (!before) throw new Error('expected a member');
			const request = { state: 'Pending' as const, step: 0, requestor: 'member:someone-else', user: null,
				route: { kind: 'steps' as const, steps: [{ name: 'Review', teams: ['sales-id'], users: [] }], superseded_by: [] } };
			expect(canApprove(request, before)).toBe(true);
			expect(canApprove({ ...request, user: reader.id }, before)).toBe(false);
			t.clock.advance('1s');
			expect((yield* member())?.actor).toMatchObject({ teams: ['branch-id','viewer-id'] });
			yield* write('UPDATE role_assignments SET until = null WHERE member = $1', [reader.id]);
			expect((yield* member())?.policies).toEqual(['sales', 'viewer']);
			yield* write("UPDATE role_levels SET team = 'viewer-id' WHERE role = 'managers'");
			expect((yield* member())?.policies).toEqual(['viewer']);
			yield* write('DELETE FROM grants WHERE member = $1', [reader.id]);
			yield* write('DELETE FROM role_assignments WHERE member = $1', [reader.id]);
			expect((yield* member())?.actor).toMatchObject({ teams: ['branch-id'] });
			yield* write('UPDATE sys_user SET active = false WHERE id = $1', [reader.id]);
			expect(yield* member()).toBeNull();
		})
	);

	it.effect('affiliation, invitations and API keys admit only a team on file', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace,
				h = yield* HostIdentity,
				authorities = new Authorities(t.manifest, 'source-one');
			const member = t.member([]),
				admin = (yield* t.as(t.admin)).authority;
			expect(yield* assign_team(h, admin, member.id, 'sales-id')).toBeNull();
			for (const handle of ['Sales', 'toString'])
				expect(
					yield* Effect.flip(assign_team(h, admin, member.id, handle))
				).toMatchObject({
					code: 'not_found'
				});
			const [row] = yield* t.db.read([
				{ text: 'SELECT team FROM sys_user WHERE id = $1', params: [member.id] }
			]);
			expect(row?.rows).toEqual([{ team: 'sales-id' }]);
			expect(
				yield* Effect.flip(
					invite(h, admin, { email: 'person@example.test', team: 'copied-label' })
				)
			).toMatchObject({ code: 'not_found' });
			expect(
				yield* Effect.flip(issueKey(h, admin, 'Invalid', 'copied-label'))
			).toMatchObject({
				code: 'not_found'
			});
			const key = yield* issueKey(h, admin, 'Catalogue', 'viewer-id');
			expect((yield* authorities.api_key(t.db, key.id))?.policies).toEqual(['viewer']);
		})
	);

	it.effect(
		'notice fan-out follows the direct team and signup policies, one notice per member',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const sales = t.member([]),
					branch = t.member([]),
					signedUp = t.member([]);
				yield* t.db.write({
					text: "UPDATE sys_user SET team = CASE WHEN id = $1 THEN 'sales-id' ELSE 'branch-id' END WHERE id IN ($1,$2)",
					params: [sales.id, branch.id]
				});
				yield* t.db.write({
					text: 'UPDATE sys_user SET signup = true WHERE id = $1',
					params: [signedUp.id]
				});
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
					POLICIES
				);
				yield* t.db.write(c.sql('1 AS done'));
				const origin = new Chain();
				noticeInsert(
					origin,
					'n',
					[
						{
							id: 'signup-notice',
							to: [{ policy: 'viewer' }],
							title: 'Signup holders',
							attachments: [],
							once: 'signup-notice'
						}
					],
					t.clock.now(),
					'true',
					POLICIES,
					['viewer']
				);
				yield* t.db.write(origin.sql('1 AS done'));
				const [rows] = yield* t.db.read([
					{
						text: 'SELECT member FROM sys_notification WHERE member IN ($1,$2,$3) ORDER BY member',
						params: [sales.id, branch.id, signedUp.id]
					}
				]);
				expect(rows?.rows).toEqual(
					[{ member: sales.id }, { member: signedUp.id }].sort((a, b) =>
						a.member.localeCompare(b.member)
					)
				);
			})
	);

	it.effect(
		'self-signup policies never spread to invited external members',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
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
				expect((yield* readers.member(t.db, 'bootstrap', signup.id))?.policies).toEqual(['viewer']);
				expect((yield* readers.member(t.db, 'bootstrap', invited.id))?.policies).toEqual([]);
				expect(
					(yield* new Authorities(
						{
							...current,
							workspace: { ...current.workspace, signup: { via: ['email'], policies: [] } }
						},
						'signup-two'
					).member(t.db, 'bootstrap', signup.id))?.policies
				).toEqual([]);
			})
	);
});

const bound: EngineManifest = {
	...source,
	workspace: { ...source.workspace, memberships: { model: 'assignments' } },
	models: { ...source.models, assignments: { description: 'Memberships', fields: { until: { kind: 'date', optional: true } } } },
	relationships: { ...source.relationships, 'assignments.member': { to: 'sys_user' }, 'assignments.team': { to: 'sys_team' } },
	exposures: { ...source.exposures, assignments: {
		outputs: { default: { assignments: { fields: 'all' } } },
		create: { columns: { assignments: ['team', 'member', 'until'] } },
		delete: {}
	} },
	policies: { ...source.policies, attempted: { description: 'Tests direct grant protection', grants: {
		assignments: { create: {}, outputs: { default: {} }, delete: {} }
	} } }
};

layer(TestWorkspace.layer({ manifest: bound }))('protected membership rows', (it) => {
	it.effect('a signed-in employee cannot issue or revoke even with an ordinary write policy; an Owner can', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace, address = 'membership-test@example.test';
			yield* t.db.write({
				text: teams_sql({ 'sales-id': { name: 'Sales', policies: ['sales'] }, basic: { policies: ['attempted'] } }),
				params: []
			});
			const actor = t.member([], { email: address, teams: ['basic'] });
			yield* t.as(actor);
			const admitted = () => t.sign_in(address);
			const signed = yield* t.as(yield* admitted()), admin = yield* t.as(t.admin);
			const issue: Readonly<Record<string, Json>> = { 'assignments.create': [{ member: actor.id, team: 'sales-id' }] };
			expect((yield* Effect.exit(signed.act(issue)))._tag).toBe('Failure');
			const added = yield* admin.act(issue);
			const record = added.records[0];
			if (!record) throw new Error('expected one assignment');
			const fresh = yield* admitted();
			expect(fresh.actor).toMatchObject({ teams: ['basic', 'sales-id'], admin: false });
			const revoke: Readonly<Record<string, Json>> = { 'assignments.delete': [{ target: { id: record.id, revision: record.revision } }] };
			expect((yield* Effect.exit((yield* t.as(fresh)).act(revoke)))._tag).toBe('Failure');
			yield* admin.act(revoke);
			expect((yield* admitted()).actor).toMatchObject({ teams: ['basic'], admin: false });
			if (fresh.actor.kind !== 'member') throw new Error('expected the original member');
			const engine = yield* Automations;
			const run = { id: 'queued', automation: 'review', input: {}, cause: 'start', depth: 0, attempts: 1,
				starter: null, trigger: { kind: 'person' as const, actor: fresh.actor } };
			const holder = { actor: { kind: 'system' as const, run: run.id, by: { automation: run.automation } },
				policies: [], admin: false };
			expect(yield* Effect.flip(engine.invoke(run, holder, {}))).toMatchObject({ code: 'forbidden' });
		})
	);
});
