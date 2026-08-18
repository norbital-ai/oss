import { describe, expect, it } from 'vitest';
import { resolveWorkspaceAgentName } from '../../src/client/ui/agent/agent-name.js';
import { workspaceAgentNameFromPackage } from '../../src/compiler/agent-name.js';

describe('workspace agent name resolution', () => {
	it('selects the first available workspace agent and honors an explicit selection', () => {
		expect(resolveWorkspaceAgentName([])).toBeUndefined();
		expect(resolveWorkspaceAgentName(['hr-payroll', 'helper'])).toBe('hr-payroll');
		expect(resolveWorkspaceAgentName(['hr-payroll', 'helper'], 'helper')).toBe('helper');
		expect(resolveWorkspaceAgentName(['hr-payroll'], 'workspace')).toBe('hr-payroll');
	});

	it('derives the authored workspace agent from the package name', () => {
		expect(workspaceAgentNameFromPackage('@template/hr-payroll')).toBe('hr-payroll');
		expect(workspaceAgentNameFromPackage('desk')).toBe('desk');
	});
});
