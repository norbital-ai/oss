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
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { parseAddress } from '../src/engine/identity/address.ts';
import { acceptInvitation, invite, setSignup } from '../src/engine/identity/members.ts';
import {
	founderBootstrap,
	loadKeys,
	loggedPhone,
	makeIdentityHost,
	sendCode,
	SIGNUP_TEXTS,
	verifyCode,
	type IdentityHost,
	type PhoneVerifier
} from '../src/engine/identity/session.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { memoryAuditLayer } from '../src/test/index.ts';

const m: EngineManifest = {
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
	teams: { Staff: ['staff'] },
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const Text = Schema.Struct({ to: Schema.String, text: Schema.String });
const port = (box: (typeof Text.Type)[]): TransportPort => ({
	async send(_kind, message) {
		box.push(Schema.decodeUnknownSync(Text)(message));
		return { providerId: 'x' };
	}
});
const ip = '5.5.5.5';
const fixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	yield* applyPlan(db, yield* plan(null, m), { accept: true });
	// The record a newcomer is: a customer on file by number, as a template's customers model would be.
	yield* db.write({ text: 'CREATE TABLE customers (id text PRIMARY KEY, phone text)', params: [] });
	yield* db.write({
		text: `INSERT INTO customers VALUES ('c-ada', '+65 8123 4567'), ('c-twin1', '+6590000000'), ('c-twin2', '+65 9000 0000')`,
		params: []
	});
	const texts: (typeof Text.Type)[] = [],
		mails: (typeof Text.Type)[] = [];
	yield* TestClock.setTime(Date.parse('2026-09-30T00:00:00Z'));
	const h = yield* makeIdentityHost({
		db,
		now: Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms))),
		windows: new RateWindows(),
		keys: yield* loadKeys(db),
		mail: port(mails),
		sms: port(texts),
		// A local host's verifier: the code it prints lands where a text would.
		phone: loggedPhone((line) => {
			const to = /→ (\+\d+):/.exec(line)?.[1];
			if (to === undefined) throw new Error('No phone number in the delivered code');
			texts.push({ to, text: line });
		}),
		publicUrl: 'https://acme.example',
		signup: m.workspace.signup
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
	Layer.provide(Layer.mergeAll(PgliteDb.layer(), NodeCrypto.layer, memoryAuditLayer))
);

layer(PhoneFixtureLive)((it) => {
	describe('addresses', () => {
		it.effect(
			'reads an email, or a mobile number with its country code; anything else is refused with a hint',
			() =>
				Effect.gen(function* () {
					const { h } = yield* PhoneFixture;
					expect(parseAddress(' Ada@Example.com ')).toEqual({
						kind: 'email',
						value: 'Ada@Example.com'
					});
					expect(parseAddress('+65 8123-4567')).toEqual({ kind: 'phone', value: '+6581234567' });
					expect(parseAddress('81234567')).toBeNull(); // no country code: ambiguous
					expect(parseAddress('ada@')).toBeNull();
					expect(yield* Effect.flip(sendCode(h, '81234567', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'check',
						message: expect.stringContaining('country code')
					});
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
					expect(yield* sendCode(h, '+6581234567', ip)).toBeNull();
					expect(texts.at(-1)).toMatchObject({
						to: '+6581234567',
						text: expect.stringMatching(/sign-in code is \d{6}/)
					});
					const s = yield* verifyCode(h, '+65 8123 4567', lastCode(), ip);
					expect(s).toMatchObject({ user: expect.any(String) });
					ada = s.user;
					expect(
						yield* one('SELECT phone, email, kind, party, admin FROM sys_user WHERE id = $1', ada)
					).toEqual([
						{
							phone: '+6581234567',
							email: null,
							kind: 'external',
							party: { model: 'customers', id: 'c-ada' },
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
				yield* sendCode(h, '+65-8123-4567', ip);
				const s = yield* verifyCode(h, '+6581234567', lastCode(), ip);
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
					yield* sendCode(h, '+6591112222', ip);
					const s = yield* verifyCode(h, '+6591112222', lastCode(), ip);
					const bob = s.user;
					expect(yield* one('SELECT party FROM sys_user WHERE id = $1', bob)).toEqual([
						{ party: null }
					]);
					yield* db.write({
						text: `INSERT INTO customers VALUES ('c-bob', '+6591112222')`,
						params: []
					}); // the desk files them later
					yield* sendCode(h, '+6591112222', ip);
					expect(yield* verifyCode(h, '+6591112222', lastCode(), ip)).toMatchObject({ user: bob });
					expect(yield* one('SELECT party FROM sys_user WHERE id = $1', bob)).toEqual([
						{ party: { model: 'customers', id: 'c-bob' } }
					]);
					yield* sendCode(h, '+6590000000', ip);
					const twin = yield* verifyCode(h, '+6590000000', lastCode(), ip);
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
					yield* sendCode(h, '+6592223333', ip);
					const s = yield* verifyCode(h, '+6592223333', lastCode(), ip);
					const cid = s.user;
					const declared = new Authorities(m, 'r2');
					expect((yield* declared.member(db, cid))?.actor).toMatchObject({ party: null });
					yield* db.write({
						text: `INSERT INTO customers VALUES ('c-cy', '+65 9222 3333')`,
						params: []
					}); // the booking files them
					expect((yield* declared.member(db, cid))?.actor).toMatchObject({
						party: { model: 'customers', id: 'c-cy' }
					});
					expect(yield* one('SELECT party FROM sys_user WHERE id = $1', cid)).toEqual([
						{ party: { model: 'customers', id: 'c-cy' } }
					]);
				})
		);

		it.effect(
			"closed by an administrator, a stranger's number is texted nothing and cannot join; a member still signs in",
			() =>
				Effect.gen(function* () {
					const { h, as, texts, lastCode } = yield* PhoneFixture;
					const boss = yield* founderBootstrap(h, 'boss@acme.example');
					const admin = yield* as(boss.user);
					expect(yield* Effect.flip(setSignup(h, yield* as(ada), false))).toMatchObject({
						code: 'forbidden'
					});
					expect(yield* setSignup(h, admin, false)).toBeNull();
					const before = texts.length;
					expect(yield* sendCode(h, '+6597776666', ip)).toBeNull(); // the same answer…
					expect(texts.length).toBe(before); // …and no text paid for
					expect(yield* Effect.flip(verifyCode(h, '+6597776666', '000000', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'invalidCode'
					});
					yield* sendCode(h, '+6581234567', ip);
					expect(texts.length).toBe(before + 1);
					expect(yield* verifyCode(h, '+6581234567', lastCode(), ip)).toMatchObject({ user: ada });
					expect(yield* setSignup(h, admin, true)).toBeNull();
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
							sendCode(capped, `+6570000${String(i).padStart(3, '0')}`, `9.9.${i}.1`)
						);
						if (Result.isSuccess(r)) sent += 1;
						else refused = r.failure;
					}
					expect(refused).toMatchObject({ _tag: 'IdentityRefusal', code: 'rateLimited' });
					expect(sent).toBeLessThan(SIGNUP_TEXTS);
					const before = texts.length;
					expect(yield* sendCode(capped, '+6581234567', '8.8.8.8')).toBeNull(); // Ada is a member
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
					expect(yield* sendCode(closed, '+6593334444', ip)).toBeNull();
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
					yield* sendCode(staff, '+447700900123', ip);
					const s = yield* verifyCode(staff, '+447700900123', lastCode(), ip);
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
	});

	describe('one number, one member', () => {
		it.effect('a founder may be a number; a number another member holds is refused', () =>
			Effect.scoped(
				Effect.gen(function* () {
					const { h } = yield* PhoneFixture;
					const context = yield* Layer.build(Layer.mergeAll(PgliteDb.layer(), memoryAuditLayer));
					const fdb = Context.get(context, TenantDb);
					yield* applyPlan(fdb, yield* plan(null, m), { accept: true });
					const fh = yield* makeIdentityHost({ ...h, db: fdb, keys: yield* loadKeys(fdb) }).pipe(
						Effect.provide(NodeCrypto.layer)
					);
					const f = yield* founderBootstrap(fh, '+65 6000 0001');
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
	yield* applyPlan(db, yield* plan(null, m), { accept: true });
	yield* db.write({ text: 'CREATE TABLE customers (id text PRIMARY KEY, phone text)', params: [] });
	yield* TestClock.setTime(Date.parse('2026-09-30T00:00:00Z'));
	const phone = verifier(),
		sms: (typeof Text.Type)[] = [];
	const vh = yield* makeIdentityHost({
		db,
		keys: yield* loadKeys(db),
		windows: new RateWindows(),
		now: Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms))),
		phone,
		sms: port(sms),
		mail: port([]),
		publicUrl: 'https://acme.example',
		signup: m.workspace.signup
	});
	return { db, vh, phone, sms };
});
class VerifierFixture extends Context.Service<
	VerifierFixture,
	Effect.Success<typeof verifierFixture>
>()('test/VerifierFixture') {}
const VerifierFixtureLive = Layer.effect(VerifierFixture, verifierFixture).pipe(
	Layer.provide(Layer.mergeAll(PgliteDb.layer(), NodeCrypto.layer, memoryAuditLayer))
);

layer(VerifierFixtureLive)((it) => {
	describe('a host phone verifier (Twilio Verify): the provider sends and checks the code, our rules still gate it', () => {
		it.effect('texts by default and uses WhatsApp when chosen; our own texts are never sent', () =>
			Effect.gen(function* () {
				const { vh, phone, sms } = yield* VerifierFixture;
				expect(yield* sendCode(vh, '+6581110000', ip)).toBeNull();
				expect(yield* sendCode(vh, '+6581110001', ip, 'whatsapp')).toBeNull();
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
					const s = yield* verifyCode(vh, '+6581110000', '424242', ip);
					expect(s).toMatchObject({ user: expect.any(String) });
					const [result] = yield* db.read([
						{ text: `SELECT via FROM sys_session WHERE "user" = $1`, params: [s.user] }
					]);
					expect(result?.rows).toEqual([{ via: 'signup' }]);
					expect(yield* Effect.flip(verifyCode(vh, '+6581110001', '000000', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'invalidCode'
					});
					expect(yield* Effect.flip(verifyCode(vh, '+6581110001', 'abc', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'invalidCode'
					}); // never asked
					expect(phone.checked).toEqual(['424242', '000000']);
					expect(yield* Effect.flip(verifyCode(vh, '+6581110001', '111111', ip))).toMatchObject({
						code: 'invalidCode'
					});
					expect(yield* Effect.flip(verifyCode(vh, '+6581110001', '424242', ip))).toMatchObject({
						code: 'invalidCode'
					}); // out of attempts
				})
		);

		it.effect('a challenge past its ten minutes is refused without asking the provider', () =>
			Effect.gen(function* () {
				const { vh, phone } = yield* VerifierFixture;
				yield* sendCode(vh, '+6581110002', ip);
				yield* TestClock.adjust('11 minutes');
				const before = phone.checked.length;
				expect(yield* Effect.flip(verifyCode(vh, '+6581110002', '424242', ip))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'invalidCode'
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
					expect(yield* sendCode(closed, '+6581110003', ip)).toBeNull();
					expect(phone.started.length).toBe(before);
					const capped = { ...vh, windows: new RateWindows() };
					let refused: unknown = null;
					for (let i = 0; i <= SIGNUP_TEXTS && refused === null; i++) {
						const r = yield* Effect.result(
							sendCode(capped, `+6571000${String(i).padStart(3, '0')}`, `7.7.${i}.1`)
						);
						if (Result.isFailure(r)) refused = r.failure;
					}
					expect(refused).toMatchObject({ _tag: 'IdentityRefusal', code: 'rateLimited' });
				})
		);

		it.effect(
			'a number signs in only where the host has a verifier, and by WhatsApp only where it sends by WhatsApp',
			() =>
				Effect.gen(function* () {
					const { vh, phone } = yield* VerifierFixture;
					const { phone: _v, ...none } = vh;
					expect(yield* Effect.flip(sendCode(none, '+6581110000', ip))).toMatchObject({
						_tag: 'IdentityRefusal',
						code: 'unavailable'
					});
					expect(yield* Effect.flip(verifyCode(none, '+6581110000', '424242', ip))).toMatchObject({
						_tag: 'IdentityRefusal'
					});
					const smsOnly: IdentityHost = { ...vh, phone: { ...phone, via: ['sms'] } };
					expect(
						yield* Effect.flip(sendCode(smsOnly, '+6581110000', ip, 'whatsapp'))
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
				expect(yield* sendCode(vh, '+6581110000', ip)).toBeNull();
				phone.fail(true);
				expect(yield* Effect.flip(sendCode(vh, '+6581110000', '6.6.6.6'))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'upstream'
				});
				expect(yield* Effect.flip(verifyCode(vh, '+6581110000', '424242', ip))).toMatchObject({
					_tag: 'IdentityRefusal',
					code: 'upstream'
				});
				phone.fail(false);
				expect(yield* verifyCode(vh, '+6581110000', '424242', ip)).toMatchObject({
					user: expect.any(String)
				}); // failure spent no attempt
			})
		);
	});
});
