import { describe, expect, it } from 'vitest';
import {
	canShowAutomationSource,
	canShowStudioSource,
	presentAutomationStatus
} from '../src/client/ui/system/automation-presentation.js';

describe('system automation presentation', () => {
	it('keeps pending durable work visibly running and stoppable', () => {
		expect(presentAutomationStatus('pending')).toEqual({
			status: 'pending',
			messageKey: 'bolt.automations.status.running',
			canStop: true,
			canResume: false
		});
	});

	it('keeps an actively claimed task visibly running and stoppable', () => {
		expect(presentAutomationStatus('running')).toEqual({
			status: 'running',
			messageKey: 'bolt.automations.status.running',
			canStop: true,
			canResume: false
		});
	});

	it('keeps a generated latest run stoppable before its first status snapshot arrives', () => {
		expect(presentAutomationStatus(undefined)).toEqual({
			status: 'pending',
			messageKey: 'bolt.automations.status.running',
			canStop: true,
			canResume: false
		});
	});

	it('presents terminal outcomes distinctly', () => {
		expect(presentAutomationStatus('done')).toEqual({
			status: 'done',
			messageKey: 'bolt.automations.status.completed',
			canStop: false,
			canResume: false
		});
		expect(presentAutomationStatus('failed')).toEqual({
			status: 'failed',
			messageKey: 'bolt.automations.status.failed',
			canStop: false,
			canResume: false
		});
	});

	it('hides Source unless the shell proves Studio entitlement and a source exists', () => {
		expect(canShowAutomationSource({ canEnterStudio: undefined, sourcePath: 'src/+daily.ts' })).toBe(
			false
		);
		expect(canShowAutomationSource({ canEnterStudio: false, sourcePath: 'src/+daily.ts' })).toBe(
			false
		);
		expect(canShowAutomationSource({ canEnterStudio: true, sourcePath: undefined })).toBe(false);
		expect(canShowAutomationSource({ canEnterStudio: true, sourcePath: '   ' })).toBe(false);
		expect(canShowAutomationSource({ canEnterStudio: true, sourcePath: 'src/+daily.ts' })).toBe(true);
	});

	it('shows Studio Source from projected entitlement even when the authored path is missing', () => {
		expect(canShowStudioSource(undefined)).toBe(false);
		expect(canShowStudioSource(false)).toBe(false);
		expect(canShowStudioSource(true)).toBe(true);
	});
});
