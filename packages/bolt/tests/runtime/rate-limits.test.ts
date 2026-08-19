import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Exit, Option } from 'effect';
import { defineRateLimits, rateLimitFor } from '../../src/authoring/rate-limits-schema.js';
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
const spec = defineRateLimits({
	'identity.sendCode': { window: '1 hour', limit: 2, key: 'address' },
	'collections.*': { window: '1 min', limit: 3, key: 'subject' },
	'collections.create': { window: '1 min', limit: 1, key: 'subject' }
});

const admit = (
	command: string,
	subject: { tenantId: string; userId?: string; address?: string }
) => Effect.runPromiseExit(make(spec).admit(command, subject));

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

	it('counts two addresses separately, and folds a missing one into a shared bucket', async () => {
		expect(refusal(await admit('identity.sendCode', { tenantId: 'a', address: 'one@y.z' }))).toBe(
			undefined
		);
		expect(refusal(await admit('identity.sendCode', { tenantId: 'a', address: 'two@y.z' }))).toBe(
			undefined
		);
		// Naming no address must not buy an unlimited lane. Two anonymous attempts share one bucket,
		// so the third is refused — the strict direction, deliberately.
		expect(refusal(await admit('identity.sendCode', { tenantId: 'a' }))).toBe(undefined);
		expect(refusal(await admit('identity.sendCode', { tenantId: 'a' }))).toBe(undefined);
		expect(refusal(await admit('identity.sendCode', { tenantId: 'a' }))).toBeDefined();
	});

	it('lets the most specific rule win, so one command can be tightened without restating its class', () => {
		expect(rateLimitFor(spec, 'collections.create')?.limit).toBe(1);
		expect(rateLimitFor(spec, 'collections.findMany')?.limit).toBe(3);
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
			defineRateLimits({ 'identity.sendCode': { window: 'soon', limit: 5, key: 'address' } })
		).toThrow(/not a duration/);
		expect(() =>
			defineRateLimits({ 'identity.sendCode': { window: '1 hour', limit: 0, key: 'address' } })
		).toThrow(/whole number/);
		expect(() =>
			defineRateLimits({ 'Identity SendCode': { window: '1 hour', limit: 5, key: 'address' } })
		).toThrow(/command pattern/);
	});
});
