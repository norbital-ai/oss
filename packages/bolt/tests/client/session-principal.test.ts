import {
	setWorkspaceSession,
	workspaceSession,
	type WorkspaceSession
} from '../../src/client/session.js';
import { describe, expect, it } from 'vitest';

const declare = (principal: string, credential: string): WorkspaceSession => ({
	tenantId: 'principal-contract',
	environment: 'development',
	releaseId: 'local',
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
	chatDocuments: {
		store: async (_conversation, key, file) => ({
			storage_key: key,
			file_name: file.name,
			file_size: file.size,
			mime_type: file.type || 'application/octet-stream'
		}),
		remove: async () => undefined,
		urlFor: (_conversation, key) => key
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
