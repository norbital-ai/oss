import { describe, it, expect } from 'vitest';
import { remoteQueryFamily } from '$lib/ui/state/client.js';

/**
 * A query only shows a loader when it has nothing to show, so what a *new* key inherits is what
 * decides whether a loader ever appears. The family is that inheritance group.
 *
 * The rule: a family is one slice of a collection. Re-shaping the slice inherits; moving to a
 * different slice does not.
 */
describe('remote query families follow the slice, not the collection', () => {
	const prefix = 'db:employees:';
	const path = 'collections/findMany';

	it('keeps sort and search changes of the same slice together, so the table never blanks', () => {
		const scoped = { where: { company_id: { eq: 'company-1' } } };
		const sorted = remoteQueryFamily(prefix, path, {
			...scoped,
			orderBy: { name: 'asc' },
			limit: 50
		});
		expect(
			remoteQueryFamily(prefix, path, {
				...scoped,
				orderBy: { name: 'desc' },
				limit: 50
			})
		).toBe(sorted);
		expect(remoteQueryFamily(prefix, path, { ...scoped, search: 'ali', limit: 50 })).toBe(sorted);
	});

	it('separates limit and filter scopes so incomplete or filtered rows never masquerade as complete', () => {
		const base = remoteQueryFamily(prefix, path, { limit: 50 });
		expect(remoteQueryFamily(prefix, path, { limit: 100 })).not.toBe(base);
		expect(
			remoteQueryFamily(prefix, path, { limit: 50, filters: [{ field: 'status', value: 'open' }] })
		).not.toBe(base);
	});

	it('hashes bypass credentials instead of retaining raw secrets in family keys', () => {
		const family = remoteQueryFamily(prefix, path, { bypass_secret: 'do-not-retain-me' });
		expect(family).not.toContain('do-not-retain-me');
		expect(family).toContain('opaque:');
	});

	it('separates structural scopes so a cold company view cannot inherit a false empty state', () => {
		const firstCompany = remoteQueryFamily(prefix, path, {
			where: { company_id: { eq: 'company-1' } },
			with: { employment: true },
			limit: 50
		});
		const secondCompany = remoteQueryFamily(prefix, path, {
			where: { company_id: { eq: 'company-2' } },
			with: { employment: true },
			limit: 50
		});
		const differentShape = remoteQueryFamily(prefix, path, {
			where: { company_id: { eq: 'company-1' } },
			with: { leave_type: true },
			limit: 50
		});

		expect(secondCompany).not.toBe(firstCompany);
		expect(differentShape).not.toBe(firstCompany);
	});

	/**
	 * The case that was wrong: every variation shared one family, so paging forward inherited the
	 * previous page's rows and the loader never fired for a page the device had not fetched.
	 */
	it('separates pages, so a page that is not loaded yet can show a loader', () => {
		const first = remoteQueryFamily(prefix, path, { limit: 50 });
		const second = remoteQueryFamily(prefix, path, { limit: 50, after: 'cursor-2' });
		const third = remoteQueryFamily(prefix, path, { limit: 50, after: 'cursor-3' });

		expect(second).not.toBe(first);
		expect(third).not.toBe(second);
	});

	it('treats the same page as the same family however it is re-shaped', () => {
		const page3 = remoteQueryFamily(prefix, path, { limit: 50, after: 'cursor-3' });
		expect(
			remoteQueryFamily(prefix, path, { limit: 50, after: 'cursor-3', orderBy: { name: 'desc' } })
		).toBe(page3);
	});

	it('keeps different collections and operations apart', () => {
		expect(remoteQueryFamily('db:orders:', path, {})).not.toBe(remoteQueryFamily(prefix, path, {}));
		expect(remoteQueryFamily(prefix, 'collections/count', {})).not.toBe(
			remoteQueryFamily(prefix, path, {})
		);
	});

	it('ignores a non-string cursor rather than keying on it', () => {
		const base = remoteQueryFamily(prefix, path, { limit: 50 });
		expect(remoteQueryFamily(prefix, path, { limit: 50, after: null })).toBe(base);
		expect(remoteQueryFamily(prefix, path, { limit: 50, after: undefined })).toBe(base);
	});
});
