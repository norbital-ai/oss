import { expect, it } from 'vitest';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { makeBoltTestRuntime, adminSubject, type BoltTestRuntime } from './support/bolt-test-layer.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
import { policy, workspace } from '../src/authoring/workspace-schema.js';

const definition = workspace({
	name: 'skilled-operations', version: '1.0.0', collections: [], apps: [],
	policies: [policy({ name: 'operator', effect: 'allow', actions: ['agent'], capabilities: { apps: ['*'], skills: ['payroll'] } })],
	teams: { operator: ['operator'] }, automations: [], envoys: [], integrations: [],
	prompt: 'You are the skilled operations agent.', tools: [],
	skills: [
		{ name: 'payroll', body: '# Payroll\n\nUNIQUE_SKILL_BODY_PAYROLL_ABC.' },
		{ name: 'secret-handbook', body: '# Secrets\n\nNever distributed.' }
	],
	requiredFacilities: []
});

let harness: BoltTestRuntime | undefined;
it('dumps agent and plan prompts', async () => {
	const out: string[] = [];
	try {
		const twin = cassetteTranscript(
			readCassetteFile(fileURLToPath(new URL('./assets/agents-skills-01.cassette.json', import.meta.url)))
		);
		harness = await makeBoltTestRuntime(definition, { ai: twin.ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000991');
		await harness.runtime.runPromise(agents.submit(harness.effectId('submit'), adminSubject, {
			conversationId, agentId: AgentId.make('web'), message: Agents.userAgentInput('Follow the payroll skill.'),
			mode: DirectiveMode.make('agent'), priority: DirectivePriority.make('normal') }));
		await harness.runtime.runPromise(agents.execute(harness.effectId('execute'), adminSubject, conversationId));
		const req = twin.requests[0] as unknown as { messages: Array<{ role: string; content: unknown }>; output: unknown; maxOutputTokens: number };
		const dump = JSON.stringify(req.messages);
		out.push('NMSG:' + req.messages.length);
		out.push('HAS_PAYROLL_BODY:' + dump.includes('UNIQUE_SKILL_BODY_PAYROLL_ABC'));
		out.push('HAS_SECRET_BODY:' + dump.includes('Never distributed'));
		out.push('OUTPUT:' + JSON.stringify(req.output).slice(0, 400));
		out.push('MAXTOK:' + req.maxOutputTokens);
		for (const m of req.messages) {
			const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
			out.push('PMSG:' + m.role + ':' + t.length + ':' + t.slice(0, 500).replace(/\n/g, '|'));
		}
		writeFileSync('/tmp/promptdump.txt', out.join('\n'));
		expect(true).toBe(true);
	} finally {
		await harness?.dispose();
	}
});
