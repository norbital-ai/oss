import {
	setWorkspaceSession,
	workspaceSession,
	type WorkspaceSession
} from '../../src/client/session.js';
import { describe, expect, it } from 'vitest';

const declare = (principal: string, credential: string): WorkspaceSession => ({
	workspaceId: 'principal-contract',
	tenantId: 'principal-contract',
	environment: 'development',
	releaseId: 'local',
	syncPrincipal: 'global-person-17',
	principal,
	accessScope: 'operator',
	credential,
	transport: { command: async () => null },
	syncStreamUrl: '/sync',
	files: {
		store: async () => '',
		remove: async () => undefined,
		urlFor: (key) => key
	},
	operations: { read: async () => null, run: async () => null }
});

describe('workspace principal contract', () => {
	it('keeps the stable principal distinct from the rotating bearer credential', () => {
		setWorkspaceSession(declare('tenant-user-17', 'credential-before-rotation'));
		expect(workspaceSession().principal).toBe('tenant-user-17');

		setWorkspaceSession(declare('tenant-user-17', 'credential-after-rotation'));
		expect(workspaceSession().principal).toBe('tenant-user-17');
		expect(workspaceSession().credential).toBe('credential-after-rotation');
	});
});
