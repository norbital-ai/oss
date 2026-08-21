import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Exit, Option } from 'effect';
import {
	anonymousLimits,
	rateLimitFor,
	resolvePolicyLimits,
	validatePolicyLimits
} from '../../src/authoring/rate-limits-schema.js';
import { make, RateLimited, resetRateLimits } from '../../src/runtime/rate-limits.js';

/**
 * The limiter that replaces one bucket keyed on `getClientAddress()`.
 *
 * The defect it replaces is not "the limit was too low". It is that behind a reverse proxy that key
 * resolves to *the proxy*, so every visitor to the host shared one bucket — twenty sign-in codes an
 * hour for the whole deployment between them — and a workspace served by bolt-server had no limiter
 * at all. So the cases that matter are about **who shares a bucket with whom**, not about the
 * arithmetic, which lives in `@norbital-ai/std/rate-limit` and is tested there.
 */
/**
 * The pre-sign-in surface, which is the only thing a workspace-wide file may bound.
 *
 * Every rule keyed by `address`, and that is enforced rather than conventional — there is no subject
 * at this surface, so a `subject`-keyed rule here would fold every anonymous caller into one bucket,
 * which is the exact defect this whole layer replaced.
 */
const spec = anonymousLimits({
	'identity.sendCode': { window: '1 hour', limit: 2, key: 'address' }
});

/** A holder's own budget, as `AccessControl.limits` resolves it from the policies they hold. */
const held = resolvePolicyLimits({
	'collections.*': { window: '1 min', limit: 3 },
	'collections.create': { window: '1 min', limit: 1 },
	// One command, two buckets keyed differently: each outside sender gets their own, and the envoy
	// as a whole gets one. Both apply, because being inside one of two ceilings is not admission.
	'envoys.receive': [
		{ window: '1 min', limit: 2, key: 'sender' },
		{ window: '1 min', limit: 3, key: 'subject' }
	]
});

const admit = (
	command: string,
	subject: { tenantId: string; userId?: string; address?: string; sender?: string }
) => Effect.runPromiseExit(make(spec).admit(command, subject, held));

const refusal = (exit: Exit.Exit<void, RateLimited>): RateLimited | undefined => {
	const error = Option.getOrUndefined(Exit.findErrorOption(exit));
	return error instanceof RateLimited ? error : undefined;
};

describe('the workspace rate limiter', () => {
	afterEach(() => resetRateLimits());

	it('does not let one tenant spend another tenant’s admissions', async () => {
		// The multi-tenant form of the exact defect this replaces. If the tenant were not in the key,
		// the busiest workspace on a deployment would lock out the quietest.
		expect(refusal(await admit('identity.sendCode', { tenantId: 'a', address: 'x@y.z' }))).toBe(
			undefined
		);
		expect(refusal(await admit('identity.sendCode', { tenantId: 'a', address: 'x@y.z' }))).toBe(
			undefined
		);
		expect(
			refusal(await admit('identity.sendCode', { tenantId: 'a', address: 'x@y.z' }))
		).toBeDefined();
		// Same command, same address, different workspace: untouched.
		expect(refusal(await admit('identity.sendCode', { tenantId: 'b', address: 'x@y.z' }))).toBe(
			undefined
		);
	});

	it('counts two addresses separately, and does not apply an address rule without one', async () => {
		expect(refusal(await admit('identity.sendCode', { tenantId: 'a', address: 'one@y.z' }))).toBe(
			undefined
		);
		expect(refusal(await admit('identity.sendCode', { tenantId: 'a', address: 'two@y.z' }))).toBe(
			undefined
		);
		// An address-keyed rule is about an address. If the caller supplies none, a different edge
		// control owns that malformed request; this limiter must not invent a shared identity.
		for (let attempt = 0; attempt < 3; attempt += 1)
			expect(refusal(await admit('identity.sendCode', { tenantId: 'a' }))).toBe(undefined);
	});

	it('lets the most specific rule win, so one command can be tightened without restating its class', () => {
		expect(rateLimitFor({ rules: held }, 'collections.create')[0]?.limit).toBe(1);
		expect(rateLimitFor({ rules: held }, 'collections.findMany')[0]?.limit).toBe(3);
	});

	/**
	 * **The two halves an envoy used to declare for itself, said once each in one vocabulary.**
	 *
	 * `perSenderPerMinute` is a `sender`-keyed rule and `totalPerMinute` is a `subject`-keyed one —
	 * an envoy is one subject, so every sender counts against the same key by construction. Both are
	 * on the same command, so both apply: a sender inside their own cap can still be refused because
	 * the surface as a whole is full, which is exactly what a public envoy's ceiling is for.
	 */
	it('gives each sender their own bucket and the envoy one of its own', async () => {
		const from = (sender: string) =>
			admit('envoys.receive', { tenantId: 'a', userId: 'envoy:desk', sender });
		// Two per sender.
		expect(refusal(await from('phone-1'))).toBe(undefined);
		expect(refusal(await from('phone-1'))).toBe(undefined);
		expect(refusal(await from('phone-1'))).toBeDefined();
		// A different sender is untouched by the first one's spending.
		expect(refusal(await from('phone-2'))).toBe(undefined);
		// …but the envoy's own bucket is three, and phone-1's two admissions counted against it, so
		// phone-2's second message is refused on the *surface* cap rather than on their own.
		const refused = refusal(await from('phone-2'));
		expect(refused).toBeDefined();
		expect(refused?.message).toContain('per subject');
	});

	/**
	 * A rule about a kind of caller this caller is not counts nothing.
	 *
	 * A `sender`-keyed rule reaching a signed-in person, or an `address`-keyed one reaching a
	 * session, is the ordinary case of a rule that is about somebody else — not a misconfiguration
	 * to refuse, and refusing on absence would close the door on everybody.
	 */
	it('never matches a sender-keyed rule against a human holder of the same policy', async () => {
		for (let attempt = 0; attempt < 3; attempt += 1)
			expect(
				refusal(await admit('envoys.receive', { tenantId: 'a', userId: 'person-1' }))
			).toBeUndefined();
		// The sender rule never matched; the holder's subject-wide ceiling still did.
		expect(
			refusal(await admit('envoys.receive', { tenantId: 'a', userId: 'person-1' }))
		).toBeDefined();
	});

	it('admits a command no rule matches rather than inventing a default', async () => {
		// A default here would throttle every command a workspace never thought about, at a number
		// nobody chose. The edge ceiling still applies to it.
		for (let attempt = 0; attempt < 50; attempt += 1)
			expect(refusal(await admit('secrets.status', { tenantId: 'a', userId: 'u' }))).toBe(
				undefined
			);
	});

	it('says how long to wait, in whole seconds, rather than only that it refused', async () => {
		await admit('collections.create', { tenantId: 'a', userId: 'u' });
		const refused = refusal(await admit('collections.create', { tenantId: 'a', userId: 'u' }));
		expect(refused?.retryAfterSeconds).toBeGreaterThan(0);
		expect(refused?.retryAfterSeconds).toBeLessThanOrEqual(60);
		expect(refused?.message).toContain('collections.create');
	});

	it('refuses a declaration whose window or limit cannot be read, at build time', () => {
		// A rule that never matches is indistinguishable at run time from a rule that is simply not
		// being hit, so a typo has to fail here or it reads as "the limit is working".
		expect(() =>
			anonymousLimits({ 'identity.sendCode': { window: 'soon', limit: 5, key: 'address' } })
		).toThrow(/not a duration/);
		expect(() =>
			anonymousLimits({ 'identity.sendCode': { window: '1 hour', limit: 0, key: 'address' } })
		).toThrow(/whole number/);
		expect(() =>
			anonymousLimits({ 'Identity SendCode': { window: '1 hour', limit: 5, key: 'address' } })
		).toThrow(/command pattern/);
	});

	/**
	 * Each half of the split refuses the other half's keys, so neither can drift into the other.
	 *
	 * This is what makes "everything with a holder is declared by that holder" a rule rather than a
	 * convention: a `subject`-keyed rule cannot be written where there is no subject, and an
	 * `address`-keyed one cannot be written where the caller has already signed in.
	 */
	it('keeps the pre-sign-in file and a policy from declaring each other’s rules', () => {
		expect(() =>
			anonymousLimits({ 'agents.turn': { window: '1 hour', limit: 5, key: 'subject' } })
		).toThrow(/has not signed in/);
		expect(() =>
			validatePolicyLimits(
				'sales_rep',
				resolvePolicyLimits({ 'identity.sendCode': { window: '1 hour', limit: 5, key: 'address' } })
			)
		).toThrow(/before signing in/);
	});

	/** Two rules on one command keyed the same way are one bucket with two numbers. */
	it('refuses two rules for one command with the same key', () => {
		expect(() =>
			validatePolicyLimits(
				'sales_rep',
				resolvePolicyLimits({
					'envoys.receive': [
						{ window: '1 min', limit: 2, key: 'sender' },
						{ window: '1 min', limit: 9, key: 'sender' }
					]
				})
			)
		).toThrow(/same key/);
	});
});
