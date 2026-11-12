// Phone identity (§5.11.2): a member signs in with their email or their mobile number (a texted code), an invitation
// names either or both, and a workspace that declares `signup` lets a newcomer join by proving their number — bound to
// the record that is them (a guest customer becomes a registered member). An administrator closes sign-up at run time.
import { describe, expect, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Clock, Context, Effect, Layer, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { randomUUID } from 'node:crypto';
import type { Json } from '../src/decl/values.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import type { TransportPort } from '../src/engine/contracts.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { parse_address } from '../src/engine/identity/address.ts';
import { acceptInvitation, invite, setSignup } from '../src/engine/identity/members.ts';
import {
	authenticate,
	founder_bootstrap,
	load_keys,
	logged_phone,
	make_identity_host,
	send_code,
	SIGNUP_TEXTS,
	SIGNUP_TEXTS_PER_IP,
	verify_code,
	type IdentityHost,
	type PhoneVerifier
} from '../src/engine/identity/session.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { memory_audit_layer } from '../../bolt-cli/src/test/index.ts';

const m: EngineManifest = {
	needs: [],
	workspace: {
		tz: 'UTC',
		locale: 'en',
		signup: {
			via: ['phone'],
			policies: ['customer'],
			party: { model: 'customers', match: { phone: 'phone' } }
		}
	},
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: { customer: { description: '', grants: {} }, staff: { description: '', grants: {} } },
	teams: { Staff: { policies: ['staff'] } },
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
const Text = Schema.Struct({ to: Schema.String, text: Schema.String });
const port = (box: (typeof Text.Type)[]): TransportPort => ({
	async send(_kind, message) {
		box.push(Schema.decodeUnknownSync(Text)(message));
		return { provider_id: 'x' };
	}
});
const ip = '5.5.5.5';
const fixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	// The record a newcomer is: a customer on file by number, as a template's customers model would be.
	yield* db.write({ text: 'CREATE TABLE customers (id text PRIMARY KEY, phone text)', params: [] });
	yield* db.write({
		text: `INSERT INTO customers VALUES ('c-ada', '+65 8123 4567'), ('c-twin1', '+6590000000'), ('c-twin2', '+65 9000 0000')`,
		params: []
	});
	const texts: (typeof Text.Type)[] = [],
		mails: (typeof Text.Type)[] = [];
	yield* TestClock.setTime(Date.parse('2026-09-30T00:00:00Z'));
	const h = yield* make_identity_host({
		db,
		now: Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms))),
		windows: new RateWindows(),
		keys: yield* load_keys(db),
		mail: port(mails),
		sms: port(texts),
		// A local host's verifier: the code it prints lands where a text would.
		phone: logged_phone((line) => {
			const to = /→ (\+\d+):/.exec(line)?.[1];
			if (to === undefined) throw new Error('No phone number in the delivered code');
			texts.push({ to, text: line });
		}),
		public_url: 'https://acme.example',
		signup: m.workspace.signup
	});
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
	const memberId = Effect.fnUntraced(function* (text: string) {
		const [member] = yield* one(text);
		if (typeof member?.['id'] !== 'string') throw new Error('Missing stored test member');
		return member['id'];
	});
	const lastCode = () => {
		const code = /code is (\d{6})/.exec(texts.at(-1)?.text ?? '')?.[1];
		if (code === undefined) throw new Error('No delivered sign-in code');
		return code;
	};
	return { db, h, as, one, memberId, lastCode, texts, mails };
});
class PhoneFixture extends Context.Service<PhoneFixture, Effect.Success<typeof fixture>>()(
	'test/PhoneFixture'
) {}
const PhoneFixtureLive = Layer.effect(PhoneFixture, fixture).pipe(
	Layer.provide(Layer.mergeAll(TestDb.layer(m), NodeCrypto.layer, memory_audit_layer))
);

layer(PhoneFixtureLive)((it) => {
	describe('addresses', () => {
		it.effect(
			'reads an email, or a mobile number with its country code; anything else is refused with a hint',
			() =>
				Effect.gen(function* () {
					const { h } = yield* PhoneFixture;
					expect(parse_address(' Ada@Example.com ')).toEqual({
						kind: 'email',
						value: 'Ada@Example.com'
					});
					expect(parse_address('+65 8123-4567')).toEqual({ kind: 'phone', value: '+6581234567' });
					expect(parse_address('81234567')).toBeNull(); // no country code: ambiguous
					expect(parse_address('ada@')).toBeNull();
					expect(yield* Effect.flip(send_code(h, '81234567', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'check',
						message: expect.stringContaining('country code')
					});
				})
		);
	});

	describe('last seen', () => {
		it.effect('follows a member’s own visits to the hour, and never someone acting as them', () =>
			Effect.gen(function* () {
				const { db, h, one, lastCode } = yield* PhoneFixture;
				yield* send_code(h, '+6596661111', ip);
				const s = yield* verify_code(h, '+6596661111', lastCode(), ip);
				const seen = Effect.fnUntraced(function* () {
					const [row] = yield* one('SELECT last_seen FROM sys_user WHERE id = $1', s.user);
					return row?.['last_seen'] ?? null;
				});
				expect(yield* seen()).toBeNull();
				yield* authenticate(h, s.token);
				const first = yield* seen();
				expect(first).not.toBeNull();
				// past the session memo, inside the hour: nothing to write
				yield* TestClock.adjust('30 minutes');
				yield* authenticate(h, s.token);
				expect(yield* seen()).toEqual(first);
				yield* TestClock.adjust('31 minutes');
				yield* authenticate(h, s.token);
				const second = yield* seen();
				expect(second).not.toEqual(first);
				yield* db.write({
					text: `UPDATE sys_session SET impersonated_by = "user" WHERE "user" = $1`,
					params: [s.user]
				});
				yield* TestClock.adjust('2 hours');
				yield* authenticate(h, s.token);
				expect(yield* seen()).toEqual(second);
			})
		);
	});

	describe('sign-up by mobile number (a guest becomes a member)', () => {
		let ada = '';
		it.effect(
			'a number on file signs up with one texted code: an external member holding the sign-up policies, bound to their record',
			() =>
				Effect.gen(function* () {
					const { h, as, one, lastCode, texts } = yield* PhoneFixture;
					expect(yield* send_code(h, '+6581234567', ip)).toBeNull();
					expect(texts.at(-1)).toMatchObject({
						to: '+6581234567',
						text: expect.stringMatching(/sign-in code is \d{6}/)
					});
					const s = yield* verify_code(h, '+65 8123 4567', lastCode(), ip);
					expect(s).toMatchObject({ user: expect.any(String) });
					ada = s.user;
					expect(
						yield* one('SELECT phone, email, kind, party, admin FROM sys_user WHERE id = $1', ada)
					).toEqual([
						{
							phone: '+6581234567',
							email: null,
							kind: 'external',
							party: { model: 'customers', id: 'c-ada', matched: true },
							admin: false
						}
					]);
					expect((yield* as(ada)).policies).toEqual(['customer']);
					expect(yield* one(`SELECT via FROM sys_session WHERE "user" = $1`, ada)).toEqual([
						{ via: 'signup' }
					]);
				})
		);

		it.effect('the same number signs in again as the same member, however it is spelled', () =>
			Effect.gen(function* () {
				const { h, one, lastCode } = yield* PhoneFixture;
				yield* send_code(h, '+65-8123-4567', ip);
				const s = yield* verify_code(h, '+6581234567', lastCode(), ip);
				expect(s.user).toBe(ada);
				expect(
					yield* one(`SELECT count(*)::int AS n FROM sys_user WHERE phone_key = '6581234567'`)
				).toEqual([{ n: 1 }]);
			})
		);

		it.effect(
			'a newcomer with no record joins unbound, and is bound once their record exists; a number two records hold binds neither',
			() =>
				Effect.gen(function* () {
					const { db, h, one, lastCode } = yield* PhoneFixture;
					yield* send_code(h, '+6591112222', ip);
					const s = yield* verify_code(h, '+6591112222', lastCode(), ip);
					const bob = s.user;
					expect(yield* one('SELECT party FROM sys_user WHERE id = $1', bob)).toEqual([
						{ party: null }
					]);
					yield* db.write({
						text: `INSERT INTO customers VALUES ('c-bob', '+6591112222')`,
						params: []
					}); // the desk files them later
					yield* send_code(h, '+6591112222', ip);
					expect(yield* verify_code(h, '+6591112222', lastCode(), ip)).toMatchObject({ user: bob });
					expect(yield* one('SELECT party FROM sys_user WHERE id = $1', bob)).toEqual([
						{ party: { model: 'customers', id: 'c-bob', matched: true } }
					]);
					yield* send_code(h, '+6590000000', ip);
					const twin = yield* verify_code(h, '+6590000000', lastCode(), ip);
					expect(yield* one('SELECT party FROM sys_user WHERE id = $1', twin.user)).toEqual([
						{ party: null }
					]);
				})
		);

		it.effect(
			'a newcomer is bound to their record as soon as it exists, without signing in again',
			() =>
				Effect.gen(function* () {
					const { db, h, one, lastCode } = yield* PhoneFixture;
					yield* send_code(h, '+6592223333', ip);
					const s = yield* verify_code(h, '+6592223333', lastCode(), ip);
					const cid = s.user;
					const declared = new Authorities(m, 'r2');
					expect((yield* declared.member(db, 'bootstrap', cid))?.actor).toMatchObject({ party: null });
					yield* db.write({
						text: `INSERT INTO customers VALUES ('c-cy', '+65 9222 3333')`,
						params: []
					}); // the booking files them
					expect((yield* declared.member(db, 'bootstrap', cid))?.actor).toMatchObject({
						party: { model: 'customers', id: 'c-cy' }
					});
					expect(yield* one('SELECT party FROM sys_user WHERE id = $1', cid)).toEqual([
						{ party: { model: 'customers', id: 'c-cy', matched: true } }
					]);
				})
		);

		it.effect(
			'a link lasts only while the record holds the number: the old number opens nothing, at once, and the new one takes it',
			() =>
				Effect.gen(function* () {
					const { db, h, one, lastCode } = yield* PhoneFixture;
					const signUp = Effect.fnUntraced(function* (phone: string) {
						yield* send_code(h, phone, ip);
						return (yield* verify_code(h, phone, lastCode(), ip)).user;
					});
					yield* db.write({
						text: `INSERT INTO customers VALUES ('c-dee', '+6597771111')`,
						params: []
					});
					const old = yield* signUp('+6597771111');
					const remembering = new Authorities(m, 'r3', { remember: true });
					expect((yield* remembering.member(db, 'bootstrap', old))?.actor).toMatchObject({
						party: { model: 'customers', id: 'c-dee' }
					});
					// the desk corrects the number, as it can on any record, and no sign-in follows
					yield* db.write({
						text: `UPDATE customers SET phone = '+6597772222' WHERE id = 'c-dee'`,
						params: []
					});
					expect((yield* remembering.member(db, 'bootstrap', old))?.actor).toMatchObject({ party: null });
					expect(yield* one('SELECT party FROM sys_user WHERE id = $1', old)).toEqual([
						{ party: null }
					]);
					const moved = yield* signUp('+6597772222');
					expect((yield* remembering.member(db, 'bootstrap', moved))?.actor).toMatchObject({
						party: { model: 'customers', id: 'c-dee' }
					});
					// the old number's holder keeps their account, and a record of their own binds as any other does
					yield* db.write({
						text: `INSERT INTO customers VALUES ('c-old', '+65 9777 1111')`,
						params: []
					});
					expect((yield* remembering.member(db, 'bootstrap', old))?.actor).toMatchObject({
						party: { model: 'customers', id: 'c-old' }
					});
					// a deleted record ends a link the same way
					yield* db.write({ text: `DELETE FROM customers WHERE id = 'c-old'`, params: [] });
					expect((yield* remembering.member(db, 'bootstrap', old))?.actor).toMatchObject({ party: null });
				})
		);

		it.effect('a second record with the number leaves the link where it is', () =>
			Effect.gen(function* () {
				const { db, h, lastCode } = yield* PhoneFixture;
				yield* db.write({
					text: `INSERT INTO customers VALUES ('c-eve', '+6594445555')`,
					params: []
				});
				yield* send_code(h, '+6594445555', ip);
				const eve = (yield* verify_code(h, '+6594445555', lastCode(), ip)).user;
				yield* db.write({
					text: `INSERT INTO customers VALUES ('c-eve2', '+65 9444 5555')`,
					params: []
				});
				expect((yield* new Authorities(m, 'r4').member(db, 'bootstrap', eve))?.actor).toMatchObject({
					party: { model: 'customers', id: 'c-eve' }
				});
			})
		);

		it.effect(
			"closed by an administrator, a stranger's number is texted nothing and cannot join; a member still signs in",
			() =>
				Effect.gen(function* () {
					const { h, as, texts, lastCode } = yield* PhoneFixture;
					const boss = yield* founder_bootstrap(h, 'boss@acme.example');
					const admin = yield* as(boss.user);
					expect(yield* Effect.flip(setSignup(h, yield* as(ada), false))).toMatchObject({
						code: 'forbidden'
					});
					expect(yield* setSignup(h, admin, false)).toBeNull();
					const before = texts.length;
					expect(yield* Effect.flip(send_code(h, '+6597776666', ip))).toMatchObject({
						code: 'not_member'
					});
					expect(texts.length).toBe(before);
					expect(yield* Effect.flip(verify_code(h, '+6597776666', '000000', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'invalid_code'
					});
					yield* send_code(h, '+6581234567', ip);
					expect(texts.length).toBe(before + 1);
					expect(yield* verify_code(h, '+6581234567', lastCode(), ip)).toMatchObject({ user: ada });
					expect(yield* setSignup(h, admin, true)).toBeNull();
				})
		);

		it.effect('one caller cannot spend the hour’s sign-up texts for everyone', () =>
			Effect.gen(function* () {
				const { h } = yield* PhoneFixture;
				const capped = { ...h, windows: new RateWindows() };
				let sent = 0,
					refused: unknown = null;
				for (let i = 0; i <= SIGNUP_TEXTS_PER_IP && refused === null; i++) {
					const r = yield* Effect.result(
						send_code(capped, `+6571000${String(i).padStart(3, '0')}`, '7.7.7.7')
					);
					if (Result.isSuccess(r)) sent += 1;
					else refused = r.failure;
				}
				expect(refused).toMatchObject({ code: 'rate_limited' });
				expect(sent).toBe(SIGNUP_TEXTS_PER_IP);
				expect(yield* send_code(capped, '+6571001000', '7.7.7.8')).toBeNull();
			})
		);

		it.effect('where sign-up is challenged, a stranger is texted only after passing; a member never needs to', () =>
			Effect.gen(function* () {
				const { h, texts } = yield* PhoneFixture;
				const capped = { ...h, windows: new RateWindows() };
				const before = texts.length;
				expect(
					yield* Effect.flip(
						send_code(capped, '+6572000001', '6.6.6.6', 'sms', Effect.succeed(false))
					)
				).toMatchObject({ code: 'forbidden' });
				expect(texts.length).toBe(before);
				expect(
					yield* send_code(capped, '+6572000001', '6.6.6.6', 'sms', Effect.succeed(true))
				).toBeNull();
				// what passed is asked of strangers only: Ada signs in on any page
				expect(
					yield* send_code(capped, '+6581234567', '6.6.6.6', 'sms', Effect.succeed(false))
				).toBeNull();
			})
		);

		it.effect(
			'texts to strangers are capped for the whole workspace, however many addresses they come from; members still get theirs',
			() =>
				Effect.gen(function* () {
					const { h, texts } = yield* PhoneFixture;
					const capped = { ...h, windows: new RateWindows() };
					// Sign-ups earlier in this file already counted; each stranger comes from its own address.
					let sent = 0,
						refused: unknown = null;
					for (let i = 0; i <= SIGNUP_TEXTS && refused === null; i++) {
						const r = yield* Effect.result(
							send_code(capped, `+6570000${String(i).padStart(3, '0')}`, `9.9.${i}.1`)
						);
						if (Result.isSuccess(r)) sent += 1;
						else refused = r.failure;
					}
					expect(refused).toMatchObject({ _tag: 'IdentityRefusal', code: 'rate_limited' });
					expect(sent).toBeLessThan(SIGNUP_TEXTS);
					const before = texts.length;
					expect(yield* send_code(capped, '+6581234567', '8.8.8.8')).toBeNull(); // Ada is a member
					expect(texts.length).toBe(before + 1);
				})
		);

		it.effect(
			'a workspace that declares no sign-up texts no stranger, and only invited numbers join',
			() =>
				Effect.gen(function* () {
					const { h, texts } = yield* PhoneFixture;
					const { signup: _declared, ...closed } = h;
					const before = texts.length;
					expect(yield* Effect.flip(send_code(closed, '+6593334444', ip))).toMatchObject({
						code: 'not_member'
					});
					expect(texts.length).toBe(before);
				})
		);
	});

	describe('invitations by mobile number', () => {
		it.effect(
			'an invitation to a number is texted, and the number signs in as the invited member',
			() =>
				Effect.gen(function* () {
					const { h, as, one, memberId, lastCode, texts } = yield* PhoneFixture;
					const admin = yield* as(
						yield* memberId(`SELECT id FROM sys_user WHERE lower(email) = 'boss@acme.example'`)
					);
					expect(yield* Effect.flip(invite(h, m, admin, {}))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'check'
					});
					expect(yield* Effect.flip(invite(h, m, admin, { phone: '98765432' }))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'check'
					});
					const inv = yield* invite(h, m, admin, { phone: '+44 7700 900123', team: 'Staff' });
					expect(inv).toMatchObject({ id: expect.any(String) });
					expect(texts.at(-1)).toMatchObject({
						to: '+447700900123',
						text: expect.stringContaining('https://acme.example/invite/')
					});
					const { signup: _declared, ...staff } = h; // joins by the invitation, not by sign-up
					yield* send_code(staff, '+447700900123', ip);
					const s = yield* verify_code(staff, '+447700900123', lastCode(), ip);
					expect(s).toMatchObject({ user: expect.any(String) });
					const who = yield* as(s.user);
					expect(who.policies).toEqual(['staff']);
					expect(yield* one(`SELECT via FROM sys_session WHERE "user" = $1`, s.user)).toEqual([
						{ via: 'invitation' }
					]);
				})
		);

		it.effect(
			'an existing member accepts an invitation to their number; a member with another number cannot',
			() =>
				Effect.gen(function* () {
					const { h, as, memberId, mails } = yield* PhoneFixture;
					const admin = yield* as(
						yield* memberId(`SELECT id FROM sys_user WHERE lower(email) = 'boss@acme.example'`)
					);
					const ada = yield* memberId(`SELECT id FROM sys_user WHERE phone_key = '6581234567'`);
					const bob = yield* memberId(`SELECT id FROM sys_user WHERE phone_key = '6591112222'`);
					const { id } = yield* invite(h, m, admin, {
						phone: '+65 8123 4567',
						email: 'ada@example.com',
						team: 'Staff'
					});
					expect(mails.at(-1)).toMatchObject({ to: 'ada@example.com' }); // both addresses are sent the link
					expect(yield* Effect.flip(acceptInvitation(h, { user: bob }, id))).toMatchObject({
						code: 'forbidden'
					});
					expect(yield* acceptInvitation(h, { user: ada }, id)).toBeNull();
				})
		);
		it.effect('a party an invitation named stays, whatever number the record holds', () =>
			Effect.gen(function* () {
				const { db, h, as, memberId, lastCode } = yield* PhoneFixture;
				const admin = yield* as(
					yield* memberId(`SELECT id FROM sys_user WHERE lower(email) = 'boss@acme.example'`)
				);
				yield* invite(h, m, admin, {
					phone: '+6595556666',
					external: true,
					party: { model: 'customers', id: 'c-twin1' }
				});
				yield* send_code(h, '+6595556666', ip);
				const guest = (yield* verify_code(h, '+6595556666', lastCode(), ip)).user;
				expect((yield* new Authorities(m, 'r6').member(db, 'bootstrap', guest))?.actor).toMatchObject({
					party: { model: 'customers', id: 'c-twin1' }
				});
			})
		);
	});

	describe('one number, one member', () => {
		it.effect('a founder may be a number; a number another member holds is refused', () =>
			Effect.scoped(
				Effect.gen(function* () {
					const { h } = yield* PhoneFixture;
					const context = yield* Layer.build(Layer.mergeAll(TestDb.layer(m), memory_audit_layer));
					const fdb = Context.get(context, TenantDb);
					const fh = yield* make_identity_host({ ...h, db: fdb, keys: yield* load_keys(fdb) }).pipe(
						Effect.provide(NodeCrypto.layer)
					);
					const f = yield* founder_bootstrap(fh, '+65 6000 0001');
					expect(f).toMatchObject({ user: expect.any(String) });
					const [result] = yield* fdb.read([
						{ text: 'SELECT phone, admin FROM sys_user', params: [] }
					]);
					expect(result?.rows).toEqual([{ phone: '+6560000001', admin: true }]);
					expect(
						yield* Effect.flip(
							fdb.write({
								text: `INSERT INTO sys_user (id, name, phone) VALUES ($1, 'Dup', '6560000001')`,
								params: [randomUUID()]
							})
						)
					).toMatchObject({ _tag: 'DbError', sqlstate: '23505' });
				})
			)
		);
	});
});

/** A verifier that holds one code per number, as Verify does; down makes every call fail. */
const verifier = () => {
	const started: { to: string; via: string }[] = [],
		checked: string[] = [];
	let down = false;
	const v: PhoneVerifier & { started: typeof started; checked: string[]; fail(on: boolean): void } =
		{
			via: ['sms', 'whatsapp'],
			started,
			checked,
			fail: (on) => {
				down = on;
			},
			async start(to, via) {
				if (down) throw new Error('verify is down');
				started.push({ to, via });
			},
			async check(_to, code) {
				if (down) throw new Error('verify is down');
				checked.push(code);
				return code === '424242';
			}
		};
	return v;
};
const verifierFixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	yield* db.write({ text: 'CREATE TABLE customers (id text PRIMARY KEY, phone text)', params: [] });
	yield* TestClock.setTime(Date.parse('2026-09-30T00:00:00Z'));
	const phone = verifier(),
		sms: (typeof Text.Type)[] = [];
	const vh = yield* make_identity_host({
		db,
		keys: yield* load_keys(db),
		windows: new RateWindows(),
		now: Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms))),
		phone,
		sms: port(sms),
		mail: port([]),
		public_url: 'https://acme.example',
		signup: m.workspace.signup
	});
	return { db, vh, phone, sms };
});
class VerifierFixture extends Context.Service<
	VerifierFixture,
	Effect.Success<typeof verifierFixture>
>()('test/VerifierFixture') {}
const VerifierFixtureLive = Layer.effect(VerifierFixture, verifierFixture).pipe(
	Layer.provide(Layer.mergeAll(TestDb.layer(m), NodeCrypto.layer, memory_audit_layer))
);

layer(VerifierFixtureLive)((it) => {
	describe('a host phone verifier (Twilio Verify): the provider sends and checks the code, our rules still gate it', () => {
		it.effect('texts by default and uses WhatsApp when chosen; our own texts are never sent', () =>
			Effect.gen(function* () {
				const { vh, phone, sms } = yield* VerifierFixture;
				expect(yield* send_code(vh, '+6581110000', ip)).toBeNull();
				expect(yield* send_code(vh, '+6581110001', ip, 'whatsapp')).toBeNull();
				expect(phone.started).toEqual([
					{ to: '+6581110000', via: 'sms' },
					{ to: '+6581110001', via: 'whatsapp' }
				]);
				expect(sms).toEqual([]);
			})
		);

		it.effect(
			"the provider's code signs a newcomer up; a wrong one is refused and counts, the third spends the challenge",
			() =>
				Effect.gen(function* () {
					const { db, vh, phone } = yield* VerifierFixture;
					const s = yield* verify_code(vh, '+6581110000', '424242', ip);
					expect(s).toMatchObject({ user: expect.any(String) });
					const [result] = yield* db.read([
						{ text: `SELECT via FROM sys_session WHERE "user" = $1`, params: [s.user] }
					]);
					expect(result?.rows).toEqual([{ via: 'signup' }]);
					expect(yield* Effect.flip(verify_code(vh, '+6581110001', '000000', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'invalid_code'
					});
					expect(yield* Effect.flip(verify_code(vh, '+6581110001', 'abc', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'invalid_code'
					}); // never asked
					expect(phone.checked).toEqual(['424242', '000000']);
					expect(yield* Effect.flip(verify_code(vh, '+6581110001', '111111', ip))).toMatchObject({
						code: 'invalid_code'
					});
					expect(yield* Effect.flip(verify_code(vh, '+6581110001', '424242', ip))).toMatchObject({
						code: 'invalid_code'
					}); // out of attempts
				})
		);

		it.effect('a challenge past its ten minutes is refused without asking the provider', () =>
			Effect.gen(function* () {
				const { vh, phone } = yield* VerifierFixture;
				yield* send_code(vh, '+6581110002', ip);
				yield* TestClock.adjust('11 minutes');
				const before = phone.checked.length;
				expect(yield* Effect.flip(verify_code(vh, '+6581110002', '424242', ip))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'invalid_code'
				});
				expect(phone.checked.length).toBe(before);
			})
		);

		it.effect(
			'a stranger is sent nothing where sign-up is closed; the workspace cap holds for verifier codes too',
			() =>
				Effect.gen(function* () {
					const { vh, phone } = yield* VerifierFixture;
					const { signup: _declared, ...closed } = vh;
					const before = phone.started.length;
					expect(yield* Effect.flip(send_code(closed, '+6581110003', ip))).toMatchObject({
						code: 'not_member'
					});
					expect(phone.started.length).toBe(before);
					const capped = { ...vh, windows: new RateWindows() };
					let refused: unknown = null;
					for (let i = 0; i <= SIGNUP_TEXTS && refused === null; i++) {
						const r = yield* Effect.result(
							send_code(capped, `+6571000${String(i).padStart(3, '0')}`, `7.7.${i}.1`)
						);
						if (Result.isFailure(r)) refused = r.failure;
					}
					expect(refused).toMatchObject({ _tag: 'IdentityRefusal', code: 'rate_limited' });
				})
		);

		it.effect(
			'a number signs in only where the host has a verifier, and by WhatsApp only where it sends by WhatsApp',
			() =>
				Effect.gen(function* () {
					const { vh, phone } = yield* VerifierFixture;
					const { phone: _v, ...none } = vh;
					expect(yield* Effect.flip(send_code(none, '+6581110000', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'unavailable'
					});
					expect(yield* Effect.flip(verify_code(none, '+6581110000', '424242', ip))).toMatchObject({
						_tag: 'IdentityRefusal'
					});
					const smsOnly: IdentityHost = { ...vh, phone: { ...phone, via: ['sms'] } };
					expect(
						yield* Effect.flip(send_code(smsOnly, '+6581110000', ip, 'whatsapp'))
					).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'unavailable',
						message: expect.stringContaining('WhatsApp')
					});
				})
		);

		it.effect('a provider failure is a failure, not a wrong code', () =>
			Effect.gen(function* () {
				const { vh, phone } = yield* VerifierFixture;
				// A member's number: the sign-up cap above is spent.
				expect(yield* send_code(vh, '+6581110000', ip)).toBeNull();
				phone.fail(true);
				expect(yield* Effect.flip(send_code(vh, '+6581110000', '6.6.6.6'))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'upstream'
				});
				expect(yield* Effect.flip(verify_code(vh, '+6581110000', '424242', ip))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'upstream'
				});
				phone.fail(false);
				expect(yield* verify_code(vh, '+6581110000', '424242', ip)).toMatchObject({
					user: expect.any(String)
				}); // failure spent no attempt
			})
		);
	});
});
