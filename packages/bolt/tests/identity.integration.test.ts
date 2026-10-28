import { describe, expect, it, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Clock, Context, Effect, Layer, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { randomUUID } from 'node:crypto';
import type { Json } from '../src/decl/values.ts';
import { OPEN_WINDOWS_SQL, RateWindows } from '../src/engine/access/rate.ts';
import type { TransportPort } from '../src/engine/contracts.ts';
import { TestDb } from '../src/test/database.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { Authorities, previewAs } from '../src/engine/identity/actor.ts';
import { directory } from '../src/engine/identity/maintenance.ts';
import {
	acceptInvitation,
	assignTeam,
	authenticateKey,
	deactivate,
	inspectInvitation,
	invite,
	issueKey,
	revokeKey,
	rotateKey,
	setAdmin
} from '../src/engine/identity/members.ts';
import {
	authenticate,
	founderBootstrap,
	loadKeys,
	makeIdentityHost,
	mint,
	sendCode,
	sha256,
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
	policies: { sales: { description: '', grants: {} }, finance: { description: '', grants: {} } },
	teams: { Sales: ['sales'], Company: ['finance'], Finance: ['finance'] },
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const Mail = Schema.Struct({
	to: Schema.String,
	text: Schema.String,
	html: Schema.optionalKey(Schema.String)
});
const RateWindow = Schema.Struct({
	rule: Schema.String,
	bucket: Schema.String,
	window_start: Schema.String,
	n: Schema.Number
});
const fixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	const keys = yield* loadKeys(db);
	expect(yield* loadKeys(db)).toEqual(keys); // 38a(e): a second cell reads the same secrets
	yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
	const outbox: (typeof Mail.Type)[] = [];
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
		keys,
		mail,
		publicUrl: 'https://acme.example'
	});
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
	return { db, h, authorities, as, one, outbox, lastCode, external: randomUUID() };
});
class IdentityFixture extends Context.Service<IdentityFixture, Effect.Success<typeof fixture>>()(
	'test/IdentityFixture'
) {}
const IdentityFixtureLive = Layer.effect(IdentityFixture, fixture).pipe(
	Layer.provide(Layer.mergeAll(TestDb.layer(m), NodeCrypto.layer, memoryAuditLayer))
);

it.live(
	'host directory matches active contacts with email precedence and gates administrator details',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = yield* TenantDb;
				yield* db.write({
					text: `INSERT INTO sys_user(id,name,email,phone,active,admin) VALUES
			('admin','Boss','Boss@directory.test',null,true,true),
			('email','Email','Match@directory.test',null,true,false),
			('phone','Phone',null,'+65 1234 5678',true,false),
			('inactive','Inactive','old@directory.test',null,false,false)`,
					params: []
				});
				const people = directory(db);
				expect(
					yield* people.memberOf({ email: ' match@directory.test ', phone: '65-12345678' })
				).toBe('email');
				expect(
					yield* people.memberOf({ email: 'missing@directory.test', phone: '65-12345678' })
				).toBe('phone');
				expect(yield* people.memberOf({ email: 'old@directory.test', phone: null })).toBeNull();
				expect(yield* people.personOf('phone')).toEqual({ email: null, phone: '+65 1234 5678' });
				expect((yield* people.members).map((member) => member.user).sort()).toEqual([
					'admin',
					'email',
					'phone'
				]);
				expect(
					(yield* people.administered('boss@directory.test'))?.map((member) => member.id).sort()
				).toEqual(['admin', 'email', 'inactive', 'phone']);
				expect(yield* people.administered('match@directory.test')).toBeNull();
			})
		).pipe(Effect.provide(TestDb.layer(m)))
);

it.live(
	'session keys initialize concurrently, reuse persisted values without writes, and reject malformed keys',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = yield* TenantDb;
				let initializations = 0;
				const observed = TenantDb.typed({
					...db,
					write: (statement, lock) =>
						Effect.suspend(() => {
							initializations++;
							return db.write(statement, lock);
						})
				});
				const [first, second] = yield* Effect.all([loadKeys(observed), loadKeys(observed)], {
					concurrency: 'unbounded'
				});
				expect(first).toEqual(second);
				expect(first.session).toHaveLength(32);
				expect(first.ipMac).toHaveLength(32);
				expect(initializations).toBeGreaterThanOrEqual(1);
				expect(initializations).toBeLessThanOrEqual(2);
				const initialized = initializations;
				expect(yield* loadKeys(observed)).toEqual(first);
				expect(yield* loadKeys(observed)).toEqual(first);
				expect(initializations).toBe(initialized);
				yield* db.write({ text: `DELETE FROM sys_config WHERE key = 'ip_mac'`, params: [] });
				const restored = yield* loadKeys(observed);
				expect(restored.session).toEqual(first.session);
				expect(restored.ipMac).toHaveLength(32);
				expect(restored.ipMac).not.toEqual(first.ipMac);
				expect(initializations).toBe(initialized + 1);
				yield* db.write({
					text: `UPDATE sys_config SET value = 'not-hex' WHERE key = 'session'`,
					params: []
				});
				expect(yield* Effect.flip(loadKeys(observed))).toBeInstanceOf(DbError);
				expect(initializations).toBe(initialized + 1);
			}).pipe(Effect.provide(TestDb.layer(m)))
		)
);

layer(IdentityFixtureLive)((it) => {
	describe('engine/identity (§5.11, rules 37–39)', () => {
		let founder = '',
			invited = '';
		it.effect(
			'founder.bootstrap creates the first admin and is idempotent per address; a second founder is refused',
			() =>
				Effect.gen(function* () {
					const { h, as } = yield* IdentityFixture;
					const a = yield* founderBootstrap(h, 'Boss@Acme.example');
					const b = yield* founderBootstrap(h, 'boss@acme.example');
					expect(a.user).toBe(b.user);
					founder = a.user;
					expect(yield* Effect.flip(founderBootstrap(h, 'other@acme.example'))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'forbidden'
					});
					expect((yield* as(founder)).admin).toBe(true);
					const audit = h.audit;
					if (audit === undefined) throw new Error('Missing durable identity audit');
					const events = yield* audit.query({
						category: 'identity',
						action: 'founder.bootstrap',
						limit: 20
					});
					const terminal = events.rows.filter((event) => event.id.endsWith(':terminal'));
					expect(terminal.map((event) => event.status).sort()).toEqual([
						'committed',
						'committed',
						'refused'
					]);
					const records = yield* Effect.forEach(events.rows, (event) => audit.detail(event.id));
					for (const event of records.filter(
						(event) => event?.status === 'committed' && event.id.endsWith(':terminal')
					))
						expect(event).toMatchObject({
							actor: { kind: 'system', id: 'host' },
							payload: { outcome: { kind: 'committed', output: { user: a.user, count: 1 } } }
						});
					for (const secret of [a.token, b.token, sha256(a.token), sha256(b.token)])
						expect(JSON.stringify(records)).not.toContain(secret);
				})
		);

		it.effect(
			'sign-in: same answer for a stranger, 3 attempts per code, single use, session authenticates (rule 38a)',
			() =>
				Effect.gen(function* () {
					const { h, one, lastCode } = yield* IdentityFixture;
					expect(yield* sendCode(h, 'stranger@x.example', '1.1.1.1')).toBeNull();
					expect(
						yield* Effect.flip(verifyCode(h, 'stranger@x.example', lastCode(), '1.1.1.1'))
					).toMatchObject({ _tag: 'IdentityRefusal', code: 'notMember' });
					yield* sendCode(h, 'boss@acme.example', '1.1.1.1');
					const code = lastCode(),
						wrong = code === '000000' ? '000001' : '000000';
					expect(
						yield* Effect.flip(verifyCode(h, 'boss@acme.example', wrong, '1.1.1.1'))
					).toMatchObject({ code: 'invalidCode' });
					const s = yield* verifyCode(h, 'boss@acme.example', code, '1.1.1.1');
					expect(s).toMatchObject({ user: founder, token: expect.any(String) });
					expect(
						yield* Effect.flip(verifyCode(h, 'boss@acme.example', code, '1.1.1.1'))
					).toMatchObject({ code: 'invalidCode' }); // consumed
					expect(yield* authenticate(h, s.token)).toMatchObject({ user: founder });
					expect(
						yield* one('SELECT count(*)::int AS n FROM sys_session WHERE token_hash = $1', s.token)
					).toEqual([{ n: 0 }]);
					yield* sendCode(h, 'boss@acme.example', '1.1.1.1');
					const c2 = lastCode(),
						bad = c2 === '111111' ? '222222' : '111111';
					for (let i = 0; i < 3; i++)
						expect(
							yield* Effect.flip(verifyCode(h, 'boss@acme.example', bad, '1.1.1.1'))
						).toMatchObject({ code: 'invalidCode' });
					expect(
						yield* Effect.flip(verifyCode(h, 'boss@acme.example', c2, '1.1.1.1'))
					).toMatchObject({ code: 'invalidCode' }); // 3 attempts spent it
				})
		);

		it.effect(
			'a mail refusal is returned and nothing is claimed sent (38a(c)); the dev sink uses 123456 (38a(f))',
			() =>
				Effect.gen(function* () {
					const { h, outbox } = yield* IdentityFixture;
					const failing: TransportPort = {
						async send() {
							throw new Error('smtp down');
						}
					};
					expect(
						yield* Effect.flip(
							sendCode({ ...h, mail: failing }, 'mailfail@acme.example', '9.9.9.1')
						)
					).toMatchObject({ _tag: 'IdentityRefusal', code: 'upstream' });
					yield* sendCode({ ...h, devSink: true }, 'boss@acme.example', '9.9.9.1');
					expect(outbox.at(-1)).toMatchObject({
						text: expect.stringContaining('123456'),
						html: expect.stringContaining('>123456<')
					});
					expect(yield* verifyCode(h, 'boss@acme.example', '123456', '9.9.9.1')).toMatchObject({
						user: founder
					});
				})
		);

		it.effect(
			'the 6th sendCode for an address in an hour is refused; a fresh cell still refuses it; no plain address is stored (rule 38)',
			() =>
				Effect.gen(function* () {
					const { db, h, one } = yield* IdentityFixture;
					for (let i = 0; i < 5; i++)
						expect(yield* sendCode(h, 'flood@acme.example', `3.3.3.${i}`)).toBeNull();
					expect(yield* Effect.flip(sendCode(h, 'flood@acme.example', '3.3.3.9'))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'rateLimited'
					});
					const fresh = new RateWindows();
					fresh.load(yield* db.rows(RateWindow, { text: OPEN_WINDOWS_SQL, params: [] }));
					expect(
						yield* Effect.flip(sendCode({ ...h, windows: fresh }, 'flood@acme.example', '3.3.3.10'))
					).toMatchObject({ code: 'rateLimited' });
					const stored = JSON.stringify(yield* one('SELECT * FROM bolt_rate'));
					expect(stored).not.toContain('flood');
					expect(stored).not.toContain('3.3.3.');
				})
		);

		it.effect(
			'invitations: admin-only; inspection is read-only; the invited member holds only its source team policies (rule 38b)',
			() =>
				Effect.gen(function* () {
					const { h, as, one, outbox, lastCode } = yield* IdentityFixture;
					const boss = yield* as(founder);
					const inv = yield* invite(h, m, boss, { email: 'rep@acme.example', team: 'Sales' });
					expect(inv).toMatchObject({ id: expect.any(String) });
					const id = inv.id;
					expect(outbox.at(-1)?.text).toContain(`https://acme.example/invite/${id}`);
					expect(
						yield* Effect.flip(invite(h, m, boss, { email: 'x@acme.example', team: 'ghost' }))
					).toMatchObject({ code: 'notFound' });
					const before = yield* one('SELECT * FROM sys_invitation WHERE id = $1', id);
					expect(yield* inspectInvitation(h, id)).toMatchObject({
						status: 'open',
						email: 'rep@acme.example'
					});
					expect(yield* one('SELECT * FROM sys_invitation WHERE id = $1', id)).toEqual(before);
					yield* sendCode(h, 'rep@acme.example', '4.4.4.4');
					const s = yield* verifyCode(h, 'rep@acme.example', lastCode(), '4.4.4.4');
					expect(s).toMatchObject({ user: expect.any(String) });
					invited = s.user;
					const rep = yield* as(invited);
					expect(rep.policies).toEqual(['sales']);
					expect(rep.actor).toMatchObject({ kind: 'member', teamPath: ['Sales'], admin: false });
					expect(yield* inspectInvitation(h, id)).toMatchObject({ status: 'accepted' });
					expect(yield* Effect.flip(invite(h, m, rep, { email: 'y@acme.example' }))).toMatchObject({
						code: 'forbidden'
					});
				})
		);

		it.effect(
			'an expired invitation refuses `expired` unchanged; another address cannot accept',
			() =>
				Effect.gen(function* () {
					const { db, h, as, one } = yield* IdentityFixture;
					const boss = yield* as(founder);
					const { id } = yield* invite(h, m, boss, { email: 'late@acme.example' });
					expect(yield* Effect.flip(acceptInvitation(h, { user: invited }, id))).toMatchObject({
						code: 'forbidden'
					});
					yield* TestClock.adjust('8 days');
					const before = yield* one('SELECT * FROM sys_invitation WHERE id = $1', id);
					expect(yield* Effect.flip(acceptInvitation(h, { user: founder }, id))).toMatchObject({
						code: 'forbidden'
					});
					yield* db.write({
						text: `UPDATE sys_user SET email = 'late@acme.example' WHERE id = $1`,
						params: [invited]
					});
					expect(yield* Effect.flip(acceptInvitation(h, { user: invited }, id))).toMatchObject({
						code: 'expired'
					});
					expect(yield* one('SELECT * FROM sys_invitation WHERE id = $1', id)).toEqual(before);
					yield* db.write({
						text: `UPDATE sys_user SET email = 'rep@acme.example' WHERE id = $1`,
						params: [invited]
					});
				})
		);

		it.effect(
			'a source hierarchy changes scopes without inheriting its parent policies; forged member choices are refused',
			() =>
				Effect.gen(function* () {
					const { db, h, as, one } = yield* IdentityFixture;
					const boss = yield* as(founder);
					const before = yield* as(invited);
					const released = new Authorities(
						{
							...m,
							teams: {
								...m.teams,
								Sales: { name: 'Sales', parent: 'Company', policies: ['sales'] }
							}
						},
						'r2'
					);
					const after = yield* released.member(db, invited);
					expect(after?.key).not.toBe(before.key);
					expect(after?.actor).toMatchObject({ teamPath: ['Sales', 'Company'], teams: ['Sales'] });
					expect(after?.policies).toEqual(['sales']);
					expect(yield* Effect.flip(assignTeam(h, m, boss, invited, 'sales'))).toMatchObject({
						code: 'notFound'
					});
					expect(yield* Effect.flip(assignTeam(h, m, boss, invited, 'forged'))).toMatchObject({
						code: 'notFound'
					});
					expect(yield* one('SELECT team FROM sys_user WHERE id = $1', invited)).toEqual([
						{ team: 'Sales' }
					]);
					expect((yield* as(founder)).key).toBe((yield* as(founder)).key);
				})
		);

		it.effect(
			'the last active admin cannot be demoted, even by two concurrent demotions; admin ⇒ staff (rule 38c)',
			() =>
				Effect.gen(function* () {
					const { db, h, as, one, external } = yield* IdentityFixture;
					const boss = yield* as(founder);
					expect(yield* Effect.flip(setAdmin(h, boss, founder, false))).toMatchObject({
						code: 'lastAdmin'
					});
					expect(yield* setAdmin(h, boss, invited, true)).toBeNull();
					const results = yield* Effect.all(
						[setAdmin(h, boss, founder, false), setAdmin(h, boss, invited, false)],
						{ concurrency: 'unbounded', mode: 'result' }
					);
					expect(results.filter(Result.isSuccess)).toHaveLength(1);
					expect(
						yield* one('SELECT count(*)::int AS n FROM sys_user WHERE admin AND active')
					).toEqual([{ n: 1 }]);
					yield* db.write({
						text: 'UPDATE sys_user SET admin = true WHERE id = $1',
						params: [founder]
					});
					// Lifecycle history stores UUID record ids, including these directly inserted identity fixtures.
					yield* db.write({
						text: `INSERT INTO sys_user (id, name, kind) VALUES ($1, 'Vendor', 'external')`,
						params: [external]
					});
					expect(yield* Effect.flip(setAdmin(h, yield* as(founder), external, true))).toMatchObject(
						{ code: 'check' }
					);
				})
		);

		it.effect(
			'API keys: shown once, authenticate, rotate, revoke; the key chooses a source team without runtime grants',
			() =>
				Effect.gen(function* () {
					const { db, h, as, one, authorities } = yield* IdentityFixture;
					const boss = yield* as(founder);
					const k = yield* issueKey(h, m, boss, 'ci', 'Finance');
					expect(yield* authenticateKey(h, k.key)).toBe(k.id);
					expect(
						yield* one('SELECT count(*)::int AS n FROM sys_api_key WHERE hash = $1', k.key)
					).toEqual([{ n: 0 }]);
					expect(yield* Effect.flip(issueKey(h, m, boss, 'forged', 'ghost'))).toMatchObject({
						code: 'notFound'
					});
					expect((yield* authorities.apiKey(db, k.id))?.policies).toEqual(['finance']);
					const r = yield* rotateKey(h, boss, k.id);
					expect(yield* authenticateKey(h, k.key)).toBeNull();
					expect(yield* authenticateKey(h, r.key)).toBe(k.id);
					yield* revokeKey(h, boss, k.id);
					expect(yield* authenticateKey(h, r.key)).toBeNull();
					expect(yield* authorities.apiKey(db, k.id)).toBeNull();
				})
		);

		it.effect('preview-as is admin-only and clears the administrator flag (rule 39)', () =>
			Effect.gen(function* () {
				const { db, as, authorities, external } = yield* IdentityFixture;
				const boss = yield* as(founder);
				const p = yield* previewAs(boss, authorities, db, founder);
				expect(p.authority.admin).toBe(false);
				expect(p.impersonatedBy).toBe(founder);
				expect(
					yield* Effect.flip(previewAs(yield* as(external), authorities, db, founder))
				).toMatchObject({ code: 'forbidden' });
			})
		);

		it.effect(
			'member and invitation writes retain history while source teams and grants have no mutable history (§5.11.1)',
			() =>
				Effect.gen(function* () {
					const { one } = yield* IdentityFixture;
					const history = yield* one(
						'SELECT collection, op, actor, changes FROM bolt_history WHERE record::text = $1 ORDER BY at, revision',
						invited
					);
					expect(history[0]).toMatchObject({
						collection: 'sys_user',
						op: 'create',
						actor: `member:${invited}`,
						changes: expect.objectContaining({ email: 'rep@acme.example' })
					});
					expect(history).toContainEqual({
						collection: 'sys_user',
						op: 'update',
						actor: `member:${founder}`,
						changes: { admin: true }
					});
					expect(
						yield* one(
							`SELECT op FROM bolt_history WHERE collection = 'sys_invitation' AND changes->>'email' = 'rep@acme.example'`
						)
					).toEqual([{ op: 'create' }]);
					expect(yield* one(`SELECT to_regclass('sys_team') IS NULL AS absent`)).toEqual([
						{ absent: true }
					]);
				})
		);

		it.effect('deactivation removes push subscriptions and refuses a new session', () =>
			Effect.gen(function* () {
				const { db, h, as, one } = yield* IdentityFixture;
				const boss = yield* as(founder);
				yield* db.write({
					text: `INSERT INTO bolt_push_subscriptions (id, "user", endpoint, keys) VALUES ('p1', $1, 'https://push', '{}')`,
					params: [invited]
				});
				expect(yield* deactivate(h, boss, invited)).toBeNull();
				expect(yield* one('SELECT count(*)::int AS n FROM bolt_push_subscriptions')).toEqual([
					{ n: 0 }
				]);
				expect(yield* Effect.flip(mint(h, invited))).toMatchObject({ code: 'notFound' });
			})
		);
	});
});
