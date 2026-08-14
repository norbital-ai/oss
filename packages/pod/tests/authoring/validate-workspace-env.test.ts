import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateDeclaredEnvVars } from '../../src/serve/validate-workspace-env.js';

describe('validateDeclaredEnvVars', () => {
	it('allows a declared key with no value', () => {
		expect(() =>
			validateDeclaredEnvVars(
				{ STRIPE_KEY: { description: 'Stripe restricted API key' } },
				{}
			)
		).not.toThrow();
	});

	it('allows a declared key whose schema would reject empty, when the value is missing', () => {
		expect(() =>
			validateDeclaredEnvVars(
				{ STRIPE_KEY: { schema: z.string().trim().min(1) } },
				{ STRIPE_KEY: '   ' }
			)
		).not.toThrow();
	});

	it('refuses a present value that fails its schema', () => {
		expect(() =>
			validateDeclaredEnvVars(
				{ PUBLIC_MAPS_REGION: { public: true, schema: z.enum(['sg', 'us']) } },
				{ PUBLIC_MAPS_REGION: 'de' }
			)
		).toThrow(/Invalid environment variable PUBLIC_MAPS_REGION/);
	});

	it('accepts a present value that matches its schema', () => {
		expect(() =>
			validateDeclaredEnvVars(
				{ PUBLIC_MAPS_REGION: { public: true, schema: z.enum(['sg', 'us']) } },
				{ PUBLIC_MAPS_REGION: 'sg' }
			)
		).not.toThrow();
	});
});
