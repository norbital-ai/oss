import type { ChatDocumentRef } from '#lib/runtime/agents/chat-messages.js';

/** One caller-owned admission identity retained only while its HTTP outcome is unknown. */
export type UnsettledAgentAdmission = Readonly<{
	conversationId: string;
	turnId: string;
	message: string;
	draft: string;
	createdConversation: boolean;
	documentKeys: readonly string[];
}>;

/** Reuses the same durable turn only when the user is retrying the exact same admission. */
export const retryableAdmission = (
	admission: UnsettledAgentAdmission | null,
	input: Readonly<{
		conversationId: string;
		message: string;
		documents: readonly ChatDocumentRef[];
	}>
): UnsettledAgentAdmission | null => {
	if (
		admission === null ||
		admission.conversationId !== input.conversationId ||
		admission.message !== input.message
	) {
		return null;
	}
	const keys = input.documents.map(({ storage_key }) => storage_key);
	return keys.length === admission.documentKeys.length &&
		keys.every((key, index) => key === admission.documentKeys[index])
		? admission
		: null;
};

/** Removes only attachments from the admission that became durable; newer draft uploads survive. */
export const withoutAdmittedDocuments = (
	documents: readonly ChatDocumentRef[],
	admission: UnsettledAgentAdmission
): ChatDocumentRef[] => {
	const admitted = new Set(admission.documentKeys);
	return documents.filter(({ storage_key }) => !admitted.has(storage_key));
};
