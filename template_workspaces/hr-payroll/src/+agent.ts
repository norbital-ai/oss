import type { AgentAutomationSpec } from '@norbital-ai/pod/authoring';

/** Permissions for the Pod-owned agent embedded in this tenant workspace. */
export default {
	description:
		'The in-workspace assistant a payroll administrator can ask about this tenant’s companies and payroll configuration, with write access to the company record and no reach beyond it.',
	kind: 'agent',
	task: 'Assist with this payroll workspace.',
	systemPrompt:
		'Follow explicit tool-use instructions exactly. Never claim a read or write succeeded unless the corresponding tool result is present. Keep final answers concise.',
	collections: ['companies'],
	access: 'write',
	hostTools: ['sandbox_read'],
	// A turn re-sends the whole window on every provider call and a reasoning model spends real tokens
	// thinking between tool calls, so a budget sized for one prompt's worth of output trips on the
	// second or third call of an ordinary question.
	maxTokens: 64_000
} satisfies AgentAutomationSpec;
