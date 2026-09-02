import { describe, expect, it } from 'vitest';
import {
	setWorkspaceSession,
	type WorkspaceSession
} from '../../src/client/session.js';
import { importCollectionRecords } from '../../src/client/ui/state/import-export.js';

const PH_REFUSAL =
	'These PH rows are not observed holidays for the legal entity: NHPMY0023 on 2026-05-08';

const sessionWithCommand = (
	command: WorkspaceSession['transport']['command']
): WorkspaceSession => ({
	workspaceId: 'import-refusal',
	tenantId: 'import-refusal',
	environment: 'development',
	releaseId: 'local',
	syncPrincipal: 'global-person-17',
	principal: 'tenant-user-17',
	accessScope: 'operator',
	credential: 'credential',
	transport: { command },
	syncStreamUrl: '/sync',
	authoringStreamUrl: '/authoring/stream',
	files: {
		store: async () => '',
		remove: async () => undefined,
		urlFor: (key) => key
	},
	operations: { read: async () => null, run: async () => null }
});

describe('importCollectionRecords refusal', () => {
	it('rejects with the command sentence, not the tryPromise defect', async () => {
		setWorkspaceSession(
			sessionWithCommand(async () => {
				throw new Error(PH_REFUSAL);
			})
		);
		await expect(
			importCollectionRecords({
				records: [
					{
						collection: 'work_days',
						id: 'import-1',
						values: { month: '2026-05' }
					}
				]
			})
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(PH_REFUSAL);
			expect((error as Error).message).not.toMatch(/An error occurred in Effect\.tryPromise/);
			return true;
		});
	});
});
