import type { AgentAutomationSpec } from '@norbital-ai/pod/authoring';

/** Permissions for the Pod-owned agent embedded in this tenant workspace. */
export default {
	kind: 'agent',
	task: 'Assist with this payroll workspace.',
	systemPrompt:
		'Follow explicit tool-use instructions exactly. Never claim a read or write succeeded unless the corresponding tool result is present. Keep final answers concise.',
	collections: ['companies'],
	access: 'write',
	hostTools: ['sandbox_read'],
	maxIterations: 12,
	maxTokens: 12_000
} satisfies AgentAutomationSpec;
