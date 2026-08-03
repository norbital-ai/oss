import { defineConnection } from '@norbital-ai/pod/authoring';
import type { Integrations } from './$types.js';

/**
 * The external system of record this workspace mirrors.
 *
 * `baseUrl` is a deployment fact, so a template can only ship a placeholder — repoint it before
 * enabling the integration. The credential is a *reference*: the name is declared in `src/+env.ts`
 * and resolved by the host at call time, so no secret value ever lives in the workspace.
 */
const externalSystem = defineConnection({
	baseUrl: 'https://erp.internal.example/api/v1',
	authentication: { type: 'bearer', token: { env: 'EXTERNAL_SYSTEM_TOKEN' } }
});

export default {
	external_system: {
		connection: externalSystem,
		receive: {
			/**
			 * Cursor-paged pull rather than a webhook, because a system of record that owns masters is
			 * usually the one thing that cannot call out to us. Pod keeps the cursor, so a missed window
			 * resumes where it stopped instead of re-importing the world.
			 */
			changed_records: {
				pull: {
					schedule: '15 * * * *',
					method: 'GET',
					path: '/masters/changed',
					cursorQuery: 'since',
					nextCursorHeader: 'x-next-cursor'
				}
			}
		},
		send: {
			/**
			 * Push only rows that are actually ours to push, and only when they become due. Sending on
			 * every write would echo inbound rows straight back at the system that just gave them to us.
			 */
			publish: {
				on: {
					create: ({ record }) =>
						record.sync_direction !== 'inbound' && record.sync_state === 'pending',
					update: ({ previous, record }) =>
						record.sync_direction !== 'inbound' &&
						record.sync_state === 'pending' &&
						previous.sync_state !== 'pending'
				},
				request: { method: 'POST', path: '/masters/acknowledge' }
			}
		}
	}
} satisfies Integrations;
