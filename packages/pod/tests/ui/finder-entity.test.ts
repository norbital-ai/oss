import { describe, expect, it } from 'vitest';
import { formatFinderEntityForPrompt } from '../../src/ui/finder/finder-entity.js';

describe('formatFinderEntityForPrompt', () => {
	it('renders an app as path plus label and description', () => {
		expect(
			formatFinderEntityForPrompt({
				kind: 'app',
				key: 'hr_controller',
				label: 'HR Controller',
				href: '/app/hr_controller',
				description: 'Payroll and people'
			})
		).toEqual({
			text: '/app/hr_controller — HR Controller: Payroll and people'
		});
	});

	it('renders a record as a collection-qualified chip', () => {
		expect(
			formatFinderEntityForPrompt({
				kind: 'record',
				collection: 'employees',
				recordId: 'e1',
				label: 'Ada Lovelace'
			})
		).toEqual({
			text: '@employees › Ada Lovelace',
			mention: {
				collection: 'employees',
				recordId: 'e1',
				label: 'employees › Ada Lovelace'
			}
		});
	});

	it('leaves step and host commands to the host', () => {
		expect(formatFinderEntityForPrompt({ kind: 'scope', collection: 'employees' })).toBeNull();
		expect(formatFinderEntityForPrompt({ kind: 'prefix', scope: 'record' })).toBeNull();
		expect(formatFinderEntityForPrompt({ kind: 'plan', query: 'rewrite' })).toBeNull();
	});
});
