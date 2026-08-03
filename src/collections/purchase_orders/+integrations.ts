import { defineConnection } from '@norbital-ai/pod/authoring';
import type { Integrations } from './$types.js';

const erp = defineConnection({
	baseUrl: 'https://erp.internal.example/api/v1',
	authentication: { type: 'bearer', token: { env: 'EXTERNAL_SYSTEM_TOKEN' } }
});

/**
 * Outbound: the confirmed purchase order is handed to the system of record.
 *
 * A mutation matching `on` writes the record to the platform's transactional outbox in the same
 * transaction as the confirm — a delivery is never queued for a write that rolled back. The host
 * drains the outbox: this collection's `export` pipeline runs, `transform` shapes the result into
 * the request body, and delivery retries with capped backoff and dead-letters after ten attempts.
 */
export default {
	erp: {
		connection: erp,
		send: {
			confirm: {
				on: {
					update: ({ previous, record }) =>
						previous.status !== 'confirmed' && record.status === 'confirmed'
				},
				request: { method: 'POST', path: '/docs/confirmed' },
				transform: ({ output }) => output[0]?.attachments[0]?.content
			}
		}
	}
} satisfies Integrations;
