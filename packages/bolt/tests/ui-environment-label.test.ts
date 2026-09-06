import { describe, expect, it } from 'vitest';
import { workspaceEnvironmentLabel } from '../src/client/ui/shell/environment-label.js';

describe('workspace environment badge label', () => {
	it('hides production', () => {
		expect(workspaceEnvironmentLabel('production')).toBeUndefined();
	});

	it('reads development as local', () => {
		expect(workspaceEnvironmentLabel('development')).toBe('local');
	});

	it('reads staging as staging', () => {
		expect(workspaceEnvironmentLabel('staging')).toBe('staging');
	});

	it('hides missing values', () => {
		expect(workspaceEnvironmentLabel(undefined)).toBeUndefined();
		expect(workspaceEnvironmentLabel('')).toBeUndefined();
		expect(workspaceEnvironmentLabel('   ')).toBeUndefined();
	});

	it('shows unknown environments verbatim rather than hiding them', () => {
		expect(workspaceEnvironmentLabel('merge-request/abc')).toBe('merge-request/abc');
	});
});
