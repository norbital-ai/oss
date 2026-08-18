import { createHash } from 'node:crypto';

/**
 * The `norbital_id` a fixture's readable user id becomes.
 *
 * Identity is an ordinary collection, so its key is `norbital_id uuid` — the type a workspace's own
 * `owner_id` references. Fixtures still name people `u1` or `user-admin-token`, because a test that
 * reads back a random uuid says nothing about who it is; the SQL casts that name through `md5()` to
 * a uuid, and this is the same derivation in TypeScript so an assertion can name the person too.
 */
export const fixtureUserId = (name: string): string => {
	const digest = createHash('md5').update(name).digest('hex');
	return [
		digest.slice(0, 8),
		digest.slice(8, 12),
		digest.slice(12, 16),
		digest.slice(16, 20),
		digest.slice(20)
	].join('-');
};
