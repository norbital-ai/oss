import { readFileSync } from 'node:fs';
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

	it('presents terminal, stopped, and resuming outcomes distinctly', () => {
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
		expect(presentAutomationStatus('paused')).toEqual({
			status: 'paused',
			label: 'Stopped',
			canStop: false,
			canResume: true
		});
		expect(presentAutomationStatus('resuming')).toEqual({
			status: 'resuming',
			label: 'Resuming',
			canStop: true,
			canResume: false
		});
	});

	it('uses the normalized status for generated and durable Stop and Resume controls', () => {
		const source = readFileSync(
			new URL('../../src/client/ui/studio/manifest-pane.svelte', import.meta.url),
			'utf8'
		);
		expect(source).toContain('{:else if run !== undefined}');
		expect(source).toContain('{#if latestStatus.canStop}');
		expect(source).toContain('{#if rowStatus.canStop}');
		expect(source).toContain('{:else if latestStatus.canResume}');
		expect(source).toContain('{:else if rowStatus.canResume}');
	});
});
