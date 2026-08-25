import { describe, expect, it } from 'vitest';
import {
	retryableAdmission,
	withoutAdmittedDocuments,
	type UnsettledAgentAdmission
} from '../../src/client/ui/agent/admission-reconciliation.js';
import type { ChatDocumentRef } from '../../src/runtime/agents/chat-messages.js';

const document = (storageKey: string): ChatDocumentRef => ({
	storage_key: storageKey,
	file_name: `${storageKey}.txt`,
	file_size: 10,
	mime_type: 'text/plain'
});

const unsettled: UnsettledAgentAdmission = {
	conversationId: 'conversation-1',
	turnId: 'turn-1',
	message: 'Run payroll',
	draft: 'Run payroll',
	createdConversation: true,
	documentKeys: ['document-1']
};

describe('agent admission reconciliation', () => {
	it('reuses a caller-owned turn only for the exact same unknown admission', () => {
		expect(
			retryableAdmission(unsettled, {
				conversationId: 'conversation-1',
				message: 'Run payroll',
				documents: [document('document-1')]
			})
		).toBe(unsettled);
		expect(
			retryableAdmission(unsettled, {
				conversationId: 'conversation-1',
				message: 'Run payroll again',
				documents: [document('document-1')]
			})
		).toBeNull();
		expect(
			retryableAdmission(unsettled, {
				conversationId: 'conversation-1',
				message: 'Run payroll',
				documents: []
			})
		).toBeNull();
	});

	it('clears only documents proven durable by the reconciled turn', () => {
		expect(
			withoutAdmittedDocuments([document('document-1'), document('document-new')], unsettled).map(
				({ storage_key }) => storage_key
			)
		).toEqual(['document-new']);
	});
});
