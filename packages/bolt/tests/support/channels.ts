import type { WorkspaceDefinition } from '../../src/authoring/workspace-schema.js';

/**
 * Bare channel declarations, the transport read off the name (`whatsapp`, `telegram_desk`,
 * `email_support`, `inbox`); anything else is a WhatsApp channel.
 */
export const testChannels = (...names: ReadonlyArray<string>): WorkspaceDefinition['channels'] =>
	names.map((name) => ({
		name,
		transport:
			(['telegram', 'email', 'inbox', 'http'] as const).find((transport) => name.startsWith(transport)) ??
			'whatsapp',
		policies: [],
		outbound: [],
		events: []
	}));
