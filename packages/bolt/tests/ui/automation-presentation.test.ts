import { describe, expect, it } from 'vitest';
import { presentAutomationStatus } from '../../src/client/ui/studio/automation-presentation.js';

describe('Studio automation status presentation', () => {
	it('keeps pending durable work visibly running and stoppable', () => {
		expect(presentAutomationStatus('pending')).toEqual({
			status: 'pending',
			label: 'Running',
			canStop: true,
			canResume: false
		});
	});

	it('keeps an actively claimed task visibly running and stoppable', () => {
		expect(presentAutomationStatus('running')).toEqual({
			status: 'running',
			label: 'Running',
			canStop: true,
			canResume: false
		});
	});

	it('keeps a generated latest run stoppable before its first status snapshot arrives', () => {
		expect(presentAutomationStatus(undefined)).toEqual({
			status: 'pending',
			label: 'Running',
			canStop: true,
			canResume: false
		});
	});

	it('presents terminal outcomes distinctly', () => {
		expect(presentAutomationStatus('done')).toEqual({
			status: 'done',
			label: 'Completed',
			canStop: false,
			canResume: false
		});
		expect(presentAutomationStatus('failed')).toEqual({
			status: 'failed',
			label: 'Failed',
			canStop: false,
			canResume: false
		});
	});
});
