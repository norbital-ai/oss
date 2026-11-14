// Member administration beyond the basics: source team selection and hierarchy, invitation resend, a
// previewed team's Authority, and the membership projection (`bolt.membership` queued in the verb's statement only
// when the host binds the port, and handed to the port by its platform run).
import { describe, expect, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { randomUUID } from 'node:crypto';
import type { Json } from '../src/decl/values.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import type { TransportPort } from '@norbital-ai/host-api';
import type { MembershipPort } from '../src/engine/contracts.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Authorities, preview_as } from '../src/engine/identity/actor.ts';
import {
	assign_team,
	deactivate,
	invite,
	inviteMany,
	membership_run,
	reactivate,
	resendInvitation,
	setAdmin
} from '../src/engine/identity/members.ts';
import {
	founder_bootstrap,
	load_keys,
	make_identity_host,
	send_code,
	verify_code
} from '../src/engine/identity/session.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { memory_audit_layer } from './support/audit.ts';

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
		Sales: { policies: ['sales', 'finance'] },
		Field: { policies: ['field'] },
		Ops: { policies: ['finance'] },
		Region: { parent: 'Ops', policies: ['sales'] },
		Depot: { parent: 'Region', policies: [] },
		Crew: { policies: ['sales'] }
	},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
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
			return { provider_id: 'x' };
		}
	};
	const h = yield* make_identity_host({
		db,
		now: Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms))),
		windows: new RateWindows(),
		keys: yield* load_keys(db),
		mail,
		public_url: 'https://acme.example'
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
	const founder = (yield* founder_bootstrap(h, 'boss@acme.example')).user;
	const authorities = new Authorities(m, 'r1');
	const as = Effect.fnUntraced(function* (user: string) {
		const authority = yield* authorities.member(db, 'bootstrap', user);
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
	Layer.provide(Layer.mergeAll(TestDb.layer(m), NodeCrypto.layer, memory_audit_layer))
);

layer(AdministrationFixtureLive)((it) => {
	describe('source team choices', () => {
		it.effect('accepts source handles and refuses forged handles and non-administrators', () =>
			Effect.gen(function* () {
				const { db, h, founder, as, external } = yield* AdministrationFixture;
				const boss = yield* as(founder);
				expect(yield* assign_team(h, m, boss, founder, 'Sales')).toBeNull();
				expect(yield* Effect.flip(assign_team(h, m, boss, founder, 'sales'))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'not_found'
				});
				expect(yield* Effect.flip(assign_team(h, m, boss, founder, 'forged'))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'not_found'
				});
				expect((yield* as(founder)).policies).toEqual(['sales', 'finance']);
				yield* db.write({
					text: `INSERT INTO sys_user (id, email, name, kind) VALUES ($1, 'e@x.example', 'Ext', 'external')`,
					params: [external]
				});
				expect(
					yield* Effect.flip(assign_team(h, m, yield* as(external), founder, 'Field'))
				).toMatchObject({ _tag: 'IdentityRefusal', code: 'forbidden' });
				yield* assign_team(h, m, boss, founder, null);
			})
		);

		it.effect(
			'resolves the declared team and its source hierarchy without a team table or inherited parent grants',
			() =>
				Effect.gen(function* () {
					const { h, founder, as, one } = yield* AdministrationFixture;
					const boss = yield* as(founder);
					expect(yield* assign_team(h, m, boss, founder, 'Region')).toBeNull();
					const member = yield* as(founder);
					if (member.actor.kind !== 'member') throw new Error('Expected native member');
					expect(member.actor.team_path).toEqual(['Region', 'Ops']);
					expect(member.policies).toEqual(['sales']);
					expect(member.teamTree).toEqual(expect.arrayContaining(['Region', 'Depot']));
					expect(yield* one(`SELECT to_regclass('sys_team') IS NULL AS absent`)).toEqual([
						{ absent: true }
					]);
					yield* assign_team(h, m, boss, founder, null);
				})
		);
	});

	describe('invitation resend', () => {
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
						code: 'not_found'
					});
					expect(yield* Effect.flip(resendInvitation(h, yield* as(external), id))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'forbidden'
					});
				})
		);
	});

	describe('preview as a team', () => {
		it.effect(
			'holds the source team policies, never admin; admin-only; an unknown team is not_found',
			() =>
				Effect.gen(function* () {
					const { db, founder, authorities, as, external } = yield* AdministrationFixture;
					const boss = yield* as(founder);
					const team = 'Sales';
					const p = yield* preview_as(boss, authorities, db, 'bootstrap', { team });
					expect([...p.authority.policies].sort()).toEqual(['finance', 'sales']);
					expect(p.authority).toMatchObject({
						admin: false,
						actor: {
							kind: 'member',
							id: founder,
							admin: false,
							teams: [team],
							team_path: ['Sales']
						},
						teamTree: [team]
					});
					expect(p.authority.key.startsWith('preview:')).toBe(true); // never links a sender handle
					expect(p.impersonatedBy).toBe(founder);
					expect(
						yield* Effect.flip(preview_as(boss, authorities, db, 'bootstrap', { team: 'nope' }))
					).toMatchObject({ code: 'not_found' });
					expect(
						yield* Effect.flip(preview_as(yield* as(external), authorities, db, 'bootstrap', { team }))
					).toMatchObject({ code: 'forbidden' });
				})
		);
	});

	describe('membership projection', () => {
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
					yield* send_code(bound, 'new@acme.example', '5.5.5.5');
					const s = yield* verify_code(bound, 'new@acme.example', lastCode(), '5.5.5.5');
					const user = s.user,
						team = 'Crew';
					yield* TestClock.adjust('1 second');
					expect(yield* assign_team(bound, m, boss, user, team)).toBeNull();
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
				expect(yield* membership_run(port)(input)).toBeNull();
				expect(seen).toEqual([input]);
				const broken: MembershipPort = {
					async project() {
						throw new Error('directory down');
					}
				};
				expect(yield* Effect.flip(membership_run(broken)(input))).toMatchObject({
					code: 'upstream',
					message: 'directory down'
				});
			})
		);
	});

	describe('identity sign-in and bulk invitations', () => {
		it.effect(
			'new invitation sign-in records birth and acceptance and queues membership once in one statement',
			() =>
				Effect.gen(function* () {
					const { db, bound, founder, as, one, lastCode } = yield* AdministrationFixture;
					const manifest = m;
					let wakes = 0;
					const host = {
						...bound,
						membership: {
							announce: () => Effect.sync(() => {
								wakes++;
							})
						}
					};
					const email = 'birth.acceptance@acme.example';
					const invitation = yield* invite(host, manifest, yield* as(founder), {
						email,
						team: 'Field'
					});
					yield* send_code(host, email, '7.7.7.7');
					const code = lastCode();
					wakes = 0;
					const session = yield* verify_code(host, email, code, '7.7.7.7');
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
					expect(yield* Effect.flip(verify_code(host, email, code, '7.7.7.7'))).toMatchObject({
						code: 'invalid_code'
					});
					expect(wakes).toBe(1);
				})
		);

		it.effect(
			'saves the entire invitation batch in one statement, after validating all addresses',
			() =>
				Effect.gen(function* () {
					const { h, founder, as, one, outbox, mail } = yield* AdministrationFixture;
					const manifest = m;
					let commits = 0;
					const host = {
						...h,
						sms: mail,
						publication: () => {
							commits++;
							return 0;
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
					expect(
						yield* one(
							'SELECT count(*)::int AS n FROM sys_invitation WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',
							sent.ids
						)
					).toEqual([{ n: 3 }]);
					expect(commits).toBe(1);
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
							return { provider_id: 'test' };
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
	});
});
