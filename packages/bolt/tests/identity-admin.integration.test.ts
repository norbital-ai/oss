// Member administration beyond the basics (rules 38c, 39, §5.11.3): source team selection and hierarchy, invitation resend, a
// previewed team's Authority, and the membership projection (`bolt.membership` queued in the verb's statement only
// when the host binds the port, and handed to the port by its platform run).
import { describe, expect, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { randomUUID } from 'node:crypto';
import type { Json } from '../src/decl/values.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import type { MembershipPort, TransportPort } from '../src/engine/contracts.ts';
import { TestDb } from '../src/test/database.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Authorities, previewAs } from '../src/engine/identity/actor.ts';
import {
	assignTeam,
	deactivate,
	invite,
	inviteMany,
	membershipRun,
	reactivate,
	resendInvitation,
	setAdmin
} from '../src/engine/identity/members.ts';
import {
	founderBootstrap,
	loadKeys,
	makeIdentityHost,
	sendCode,
	verifyCode
} from '../src/engine/identity/session.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { memoryAuditLayer } from '../src/test/index.ts';

const m: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: {
		sales: { description: '', grants: {} },
		field: { description: '', grants: {} },
		finance: { description: '', grants: {} }
	},
	teams: {
		Sales: ['sales', 'finance'],
		Field: ['field'],
		Ops: ['finance'],
		Region: { parent: 'Ops', policies: ['sales'] },
		Depot: { parent: 'Region', policies: [] },
		Crew: ['sales']
	},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const Mail = Schema.Struct({ to: Schema.String, text: Schema.String });
const clock = Date.parse('2026-09-25T00:00:00Z');
const fixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	yield* TestClock.setTime(clock);
	const outbox: (typeof Mail.Type)[] = [],
		announced: string[] = [];
	const mail: TransportPort = {
		async send(_kind, message) {
			outbox.push(Schema.decodeUnknownSync(Mail)(message));
			return { providerId: 'x' };
		}
	};
	const h = yield* makeIdentityHost({
		db,
		now: Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms))),
		windows: new RateWindows(),
		keys: yield* loadKeys(db),
		mail,
		publicUrl: 'https://acme.example'
	});
	const bound = {
		...h,
		membership: {
			announce: (at: string) =>
				Effect.sync(() => {
					announced.push(at);
				})
		}
	};
	const founder = (yield* founderBootstrap(h, 'boss@acme.example')).user;
	const authorities = new Authorities(m, 'r1');
	const as = Effect.fnUntraced(function* (user: string) {
		const authority = yield* authorities.member(db, user);
		if (authority === null) throw new Error(`No active test member ${user}`);
		return authority;
	});
	const one = Effect.fnUntraced(function* (text: string, ...params: Json[]) {
		const [result] = yield* db.read([{ text, params }]);
		if (result === undefined) throw new Error('Missing database result');
		return result.rows;
	});
	const lastCode = () => {
		const code = /(\d{6})/.exec(outbox.at(-1)?.text ?? '')?.[1];
		if (code === undefined) throw new Error('No delivered sign-in code');
		return code;
	};
	return {
		db,
		h,
		bound,
		founder,
		authorities,
		as,
		one,
		outbox,
		mail,
		announced,
		lastCode,
		external: randomUUID(),
		staff: randomUUID(),
		projected: () =>
			one(`SELECT input FROM sys_run WHERE automation = 'bolt.membership' ORDER BY due_at, id`)
	};
});
class AdministrationFixture extends Context.Service<
	AdministrationFixture,
	Effect.Success<typeof fixture>
>()('test/AdministrationFixture') {}
const AdministrationFixtureLive = Layer.effect(AdministrationFixture, fixture).pipe(
	Layer.provide(Layer.mergeAll(TestDb.layer(m), NodeCrypto.layer, memoryAuditLayer))
);

layer(AdministrationFixtureLive)((it) => {
	describe('source team choices', () => {
		it.effect('accepts source handles and refuses forged handles and non-administrators', () =>
			Effect.gen(function* () {
				const { db, h, founder, as, external } = yield* AdministrationFixture;
				const boss = yield* as(founder);
				expect(yield* assignTeam(h, m, boss, founder, 'Sales')).toBeNull();
				expect(yield* Effect.flip(assignTeam(h, m, boss, founder, 'sales'))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'notFound'
				});
				expect(yield* Effect.flip(assignTeam(h, m, boss, founder, 'forged'))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'notFound'
				});
				expect((yield* as(founder)).policies).toEqual(['sales', 'finance']);
				yield* db.write({
					text: `INSERT INTO sys_user (id, email, name, kind) VALUES ($1, 'e@x.example', 'Ext', 'external')`,
					params: [external]
				});
				expect(
					yield* Effect.flip(assignTeam(h, m, yield* as(external), founder, 'Field'))
				).toMatchObject({ _tag: 'IdentityRefusal', code: 'forbidden' });
				yield* assignTeam(h, m, boss, founder, null);
			})
		);

		it.effect(
			'resolves the declared team and its source hierarchy without a team table or inherited parent grants',
			() =>
				Effect.gen(function* () {
					const { h, founder, as, one } = yield* AdministrationFixture;
					const boss = yield* as(founder);
					expect(yield* assignTeam(h, m, boss, founder, 'Region')).toBeNull();
					const member = yield* as(founder);
					if (member.actor.kind !== 'member') throw new Error('Expected native member');
					expect(member.actor.teamPath).toEqual(['Region', 'Ops']);
					expect(member.policies).toEqual(['sales']);
					expect(member.teamTree).toEqual(expect.arrayContaining(['Region', 'Depot']));
					expect(yield* one(`SELECT to_regclass('sys_team') IS NULL AS absent`)).toEqual([
						{ absent: true }
					]);
					yield* assignTeam(h, m, boss, founder, null);
				})
		);
	});

	describe('invitation resend (rule 38c)', () => {
		it.effect(
			'an open or expired invitation gets a fresh expiry and its notice again; an accepted one is refused',
			() =>
				Effect.gen(function* () {
					const { db, h, founder, as, one, outbox, external } = yield* AdministrationFixture;
					const boss = yield* as(founder);
					const { id } = yield* invite(h, m, boss, { email: 'late@acme.example' });
					yield* TestClock.adjust('8 days'); // past the 7-day expiry
					const sent = outbox.length;
					expect(yield* resendInvitation(h, boss, id)).toBeNull();
					expect(outbox.length).toBe(sent + 1);
					expect(outbox.at(-1)).toMatchObject({ to: 'late@acme.example' });
					const [invitation] = yield* one(
						'SELECT expires_at FROM sys_invitation WHERE id = $1',
						id
					);
					if (typeof invitation?.['expires_at'] !== 'string')
						throw new Error('Missing invitation expiry');
					expect(Date.parse(invitation['expires_at'])).toBe(clock + 15 * 86_400_000);
					yield* db.write({
						text: 'UPDATE sys_invitation SET accepted_at = now() WHERE id = $1',
						params: [id]
					});
					expect(yield* Effect.flip(resendInvitation(h, boss, id))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'notFound'
					});
					expect(yield* Effect.flip(resendInvitation(h, yield* as(external), id))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'forbidden'
					});
				})
		);
	});

	describe('preview as a team (rule 39)', () => {
		it.effect(
			'holds the source team policies, never admin; admin-only; an unknown team is notFound',
			() =>
				Effect.gen(function* () {
					const { db, founder, authorities, as, external } = yield* AdministrationFixture;
					const boss = yield* as(founder);
					const team = 'Sales';
					const p = yield* previewAs(boss, authorities, db, { team });
					expect([...p.authority.policies].sort()).toEqual(['finance', 'sales']);
					expect(p.authority).toMatchObject({
						admin: false,
						actor: {
							kind: 'member',
							id: founder,
							admin: false,
							teams: [team],
							teamPath: ['Sales']
						},
						teamTree: [team]
					});
					expect(p.authority.key.startsWith('preview:')).toBe(true); // never links a sender handle (rule 39)
					expect(p.impersonatedBy).toBe(founder);
					expect(
						yield* Effect.flip(previewAs(boss, authorities, db, { team: 'nope' }))
					).toMatchObject({ code: 'notFound' });
					expect(
						yield* Effect.flip(previewAs(yield* as(external), authorities, db, { team }))
					).toMatchObject({ code: 'forbidden' });
				})
		);
	});

	describe('membership projection (§5.11.3)', () => {
		it.effect('no port bound: lifecycle verbs queue nothing', () =>
			Effect.gen(function* () {
				const { db, h, founder, as, external, projected } = yield* AdministrationFixture;
				yield* db.write({ text: 'DELETE FROM sys_run', params: [] });
				const boss = yield* as(founder);
				yield* deactivate(h, boss, external);
				yield* reactivate(h, boss, external);
				expect(yield* projected()).toEqual([]);
			})
		);

		it.effect(
			'bound: acceptance, deactivation, reactivation and a team change each queue one run in their statement',
			() =>
				Effect.gen(function* () {
					const { db, bound, founder, as, announced, lastCode, projected, staff } =
						yield* AdministrationFixture;
					const boss = yield* as(founder);
					announced.length = 0;
					const inv = yield* invite(bound, m, boss, { email: 'new@acme.example' });
					expect(inv).toMatchObject({ id: expect.any(String) });
					yield* sendCode(bound, 'new@acme.example', '5.5.5.5');
					const s = yield* verifyCode(bound, 'new@acme.example', lastCode(), '5.5.5.5');
					const user = s.user,
						team = 'Crew';
					yield* TestClock.adjust('1 second');
					expect(yield* assignTeam(bound, m, boss, user, team)).toBeNull();
					yield* TestClock.adjust('1 second');
					expect(yield* deactivate(bound, boss, user)).toBeNull();
					yield* TestClock.adjust('1 second');
					expect(yield* reactivate(bound, boss, user)).toBeNull();
					yield* TestClock.adjust('1 second');
					expect(yield* deactivate(bound, boss, user)).toBeNull();
					expect((yield* projected()).map((r) => r['input'])).toEqual([
						{ user, email: 'new@acme.example', phone: null, team: null, state: 'active' },
						{ user, email: 'new@acme.example', phone: null, team, state: 'active' },
						{ user, email: 'new@acme.example', phone: null, team, state: 'inactive' },
						{ user, email: 'new@acme.example', phone: null, team, state: 'active' },
						{ user, email: 'new@acme.example', phone: null, team, state: 'inactive' }
					]);
					expect(announced.length).toBe(5);
					// An admin flag change is not a lifecycle change; its history still needs a UUID record id.
					yield* db.write({ text: 'DELETE FROM sys_run', params: [] });
					yield* db.write({
						text: `INSERT INTO sys_user (id, email, name) VALUES ($1, 's2@acme.example', 'S2')`,
						params: [staff]
					});
					expect(yield* setAdmin(bound, boss, staff, true)).toBeNull();
					expect(yield* projected()).toEqual([]);
				})
		);

		it.effect('the platform run hands the input to the port; a port failure fails the run', () =>
			Effect.gen(function* () {
				const seen: Parameters<MembershipPort['project']>[0][] = [];
				const port: MembershipPort = {
					async project(member) {
						seen.push(member);
					}
				};
				const input = {
					user: 'u1',
					email: 'a@b.example',
					phone: null,
					team: null,
					state: 'active'
				};
				expect(yield* membershipRun(port)(input)).toBeNull();
				expect(seen).toEqual([input]);
				const broken: MembershipPort = {
					async project() {
						throw new Error('directory down');
					}
				};
				expect(yield* Effect.flip(membershipRun(broken)(input))).toMatchObject({
					code: 'upstream',
					message: 'directory down'
				});
			})
		);
	});

	describe('identity automation events and bulk invitations', () => {
		it.effect(
			'new invitation sign-in queues birth, acceptance and membership once in one statement',
			() =>
				Effect.gen(function* () {
					const { db, bound, founder, as, one, lastCode } = yield* AdministrationFixture;
					const manifest: EngineManifest = {
						...m,
						automations: {
							user_born: {
								description: 'Provision the new member profile',
								on: { created: 'sys_user' },
								runAs: ['sales']
							},
							invitation_accepted: {
								description: 'Finish the accepted invitation profile',
								on: { updated: 'sys_invitation', fields: ['accepted_at'] },
								runAs: ['sales']
							}
						}
					};
					let wakes = 0;
					const host = {
						...bound,
						events: {
							manifest,
							announce: Effect.sync(() => {
								wakes++;
							})
						}
					};
					const email = 'birth.acceptance@acme.example';
					const invitation = yield* invite(host, manifest, yield* as(founder), {
						email,
						team: 'Field'
					});
					yield* sendCode(host, email, '7.7.7.7');
					const code = lastCode();
					wakes = 0;
					const session = yield* verifyCode(host, email, code, '7.7.7.7');
					expect(wakes).toBe(1);
					expect(
						yield* one('SELECT email, name, kind, team FROM sys_user WHERE id = $1', session.user)
					).toEqual([{ email, name: 'Birth Acceptance', kind: 'staff', team: 'Field' }]);
					expect((yield* as(session.user)).policies).toEqual(['field']);
					expect(
						yield* one(
							'SELECT accepted_at IS NOT NULL AS accepted, revision FROM sys_invitation WHERE id = $1',
							invitation.id
						)
					).toEqual([{ accepted: true, revision: 2 }]);
					const events = () =>
						one(
							"SELECT automation, input, actor, cause, state FROM sys_run WHERE automation IN ('user_born', 'invitation_accepted') ORDER BY automation"
						);
					const expected = [
						{
							automation: 'invitation_accepted',
							input: { model: 'sys_invitation', ids: [invitation.id] },
							actor: `member:${session.user}`,
							cause: 'updated',
							state: 'queued'
						},
						{
							automation: 'user_born',
							input: { model: 'sys_user', ids: [session.user] },
							actor: `member:${session.user}`,
							cause: 'created',
							state: 'queued'
						}
					];
					expect(yield* events()).toEqual(expected);
					expect(
						yield* one(
							"SELECT input FROM sys_run WHERE automation = 'bolt.membership' AND input->>'user' = $1",
							session.user
						)
					).toEqual([
						{
							input: { user: session.user, email, phone: null, team: 'Field', state: 'active' }
						}
					]);
					expect(
						yield* one(
							'SELECT collection, op, revision FROM bolt_history WHERE record::text IN ($1, $2) ORDER BY collection, revision',
							session.user,
							invitation.id
						)
					).toEqual([
						{ collection: 'sys_invitation', op: 'create', revision: 1 },
						{ collection: 'sys_invitation', op: 'update', revision: 2 },
						{ collection: 'sys_user', op: 'create', revision: 1 }
					]);
					expect(
						yield* db.value(Schema.Number, {
							text: 'SELECT count(*)::int FROM sys_session WHERE "user" = $1',
							params: [session.user]
						})
					).toBe(1);
					expect(yield* Effect.flip(verifyCode(host, email, code, '7.7.7.7'))).toMatchObject({
						code: 'invalidCode'
					});
					expect(yield* events()).toEqual(expected);
					expect(wakes).toBe(1);
				})
		);

		it.effect(
			'queues a single invitation event containing the entire batch, after validating all addresses',
			() =>
				Effect.gen(function* () {
					const { h, founder, as, one, outbox, mail } = yield* AdministrationFixture;
					const manifest: EngineManifest = {
						...m,
						automations: {
							invitation_profile: {
								description: 'Provision profiles',
								on: { created: 'sys_invitation' },
								runAs: ['sales']
							}
						}
					};
					let wakes = 0;
					const host = {
						...h,
						sms: mail,
						events: {
							manifest,
							announce: Effect.sync(() => {
								wakes++;
							})
						}
					};
					const auth = yield* as(founder);
					const sent = yield* inviteMany(host, manifest, auth, [
						{ email: 'bulk-one@example.com' },
						{ email: 'bulk-two@example.com' },
						{ phone: '+6581234999' }
					]);
					expect(sent).toMatchObject({ ids: expect.any(Array) });
					expect(sent.failed).toEqual([]);
					const events = yield* one(
						"SELECT input FROM sys_run WHERE automation = 'invitation_profile'"
					);
					expect(events).toHaveLength(1);
					expect(events[0]?.['input']).toEqual({
						model: 'sys_invitation',
						ids: expect.arrayContaining(sent.ids)
					});
					expect(wakes).toBe(1);
					expect(outbox.slice(-3).map((message) => message.to)).toContain('bulk-one@example.com');
					const [before] = yield* one('SELECT count(*)::int AS n FROM sys_invitation');
					if (typeof before?.['n'] !== 'number') throw new Error('Missing invitation count');
					expect(
						yield* Effect.flip(
							inviteMany(host, manifest, auth, [
								{ email: 'valid@example.com' },
								{ email: 'invalid' }
							])
						)
					).toMatchObject({ _tag: 'IdentityRefusal' });
					expect(
						yield* Effect.flip(
							inviteMany(host, manifest, auth, [
								{ email: 'same@example.com' },
								{ email: 'SAME@example.com' }
							])
						)
					).toMatchObject({ _tag: 'IdentityRefusal' });
					expect((yield* one('SELECT count(*)::int AS n FROM sys_invitation'))[0]?.['n']).toBe(
						before['n']
					);
					expect(
						yield* Effect.flip(inviteMany(host, manifest, yield* as(founder), []))
					).toMatchObject({ _tag: 'IdentityRefusal' });
				})
		);

		it.effect(
			'continues bulk delivery after a provider failure and refuses non-administrators',
			() =>
				Effect.gen(function* () {
					const { h, founder, as, one } = yield* AdministrationFixture;
					const auth = yield* as(founder);
					const delivered: string[] = [];
					const mail: TransportPort = {
						async send(_kind, message) {
							const { to } = Schema.decodeUnknownSync(Mail)(message);
							if (to === 'failed@example.com') throw new Error('Provider failed');
							delivered.push(to);
							return { providerId: 'test' };
						}
					};
					const host = { ...h, mail };
					const sent = yield* inviteMany(host, m, auth, [
						{ email: 'failed@example.com' },
						{ email: 'delivered@example.com' }
					]);
					expect(sent).toMatchObject({ ids: expect.any(Array) });
					expect(sent.failed).toEqual([sent.ids[0]]);
					expect(
						yield* one(
							'SELECT id FROM sys_invitation WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',
							sent.ids
						)
					).toHaveLength(2);
					expect(delivered).toEqual(['delivered@example.com']);
					expect(
						yield* Effect.flip(
							inviteMany(host, m, { ...auth, admin: false }, [{ email: 'forbidden@example.com' }])
						)
					).toMatchObject({ _tag: 'IdentityRefusal' });
				})
		);

		it.effect('queues user field changes from identity administration', () =>
			Effect.gen(function* () {
				const { h, founder, as, one } = yield* AdministrationFixture;
				const manifest: EngineManifest = {
					...m,
					automations: {
						active_changed: {
							description: 'Watch activation',
							on: { updated: 'sys_user', fields: ['active'] },
							runAs: ['sales']
						}
					}
				};
				const host = { ...h, events: { manifest, announce: Effect.void } };
				const [user] = yield* one('SELECT id FROM sys_user WHERE NOT admin LIMIT 1');
				expect(user).toBeDefined();
				if (typeof user?.['id'] !== 'string') throw new Error('Missing non-administrator member');
				expect(yield* deactivate(host, yield* as(founder), user['id'])).toBeNull();
				expect(yield* one("SELECT input FROM sys_run WHERE automation = 'active_changed'")).toEqual(
					[{ input: { model: 'sys_user', ids: [user['id']] } }]
				);
			})
		);
	});
});
