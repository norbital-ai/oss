import { describe, expect, it } from 'vitest';
import {
	retryableAdmission,
	type UnsettledTaskAdmission
} from '../../src/client/ui/agent/admission-reconciliation.js';

const unsettled: UnsettledTaskAdmission = {
	taskId: 'task-1',
	agentId: 'payroll',
	message: 'Run payroll',
	mode: 'agent',
	priority: 'normal',
	draft: 'Run payroll'
};

describe('Task admission reconciliation', () => {
	it('reuses a client-minted Task id only for the exact unknown submission', () => {
		expect(
			retryableAdmission(unsettled, {
				agentId: 'payroll',
				message: 'Run payroll',
				mode: 'agent',
				priority: 'normal'
			})
		).toBe(unsettled);
	});

	it('rejects any changed Task identity instead of retrying a different directive', () => {
		expect(
			retryableAdmission(unsettled, {
				agentId: 'payroll',
				message: 'Run payroll again',
				mode: 'agent',
				priority: 'normal'
			})
		).toBeNull();
		expect(
			retryableAdmission(unsettled, {
				agentId: 'payroll',
				message: 'Run payroll',
				mode: 'plan',
				priority: 'normal'
			})
		).toBeNull();
		expect(
			retryableAdmission(unsettled, {
				agentId: 'payroll',
				message: 'Run payroll',
				mode: 'agent',
				priority: 'steer'
			})
		).toBeNull();
	});
});
