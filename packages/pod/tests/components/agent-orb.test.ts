import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	agentOrbBusyStatusKey,
	agentOrbState,
	agentOrbStatusKey,
	toolOrbActivity
} from '../../src/ui/agent/agent-orb-state.js';

const podRoot = process.cwd();
const orbSourcePath = resolve(podRoot, 'src/ui/agent/norbital-thinking-orb.svelte');
const orbStatePath = resolve(podRoot, 'src/ui/agent/agent-orb-state.ts');
const panelSourcePath = resolve(podRoot, 'src/ui/agent/agent-chat-panel.svelte');
const transcriptSourcePath = resolve(podRoot, 'src/ui/agent/agent-transcript-item.svelte');
const transcriptTsPath = resolve(podRoot, 'src/ui/agent/transcript.ts');
const shellSourcePath = resolve(podRoot, 'src/ui/shell/pod-shell.svelte');
const packagePath = resolve(podRoot, 'package.json');

describe('Norbital agent orb', () => {
	it('derives live activity from the durable session aggregate', () => {
		expect(agentOrbState({})).toBe('idle');
		expect(agentOrbState({ pending: true })).toBe('thinking');
		expect(agentOrbState({ failed: true })).toBe('failed');
		expect(
			agentOrbState({
				turns: [{ norbital_id: 'turn-1', status: 'failed', subagent_id: null }]
			})
		).toBe('failed');
		expect(
			agentOrbState({
				turns: [{ norbital_id: 'turn-1', status: 'running', subagent_id: null }],
				messages: [
					{
						norbital_id: 'message-1',
						parts: [
							{
								role: 'assistant',
								content: '',
								toolCalls: [
									{ id: 'call-1', name: 'read_collection', input: { collection: 'sites' } }
								]
							}
						]
					}
				]
			})
		).toBe('searching');
		expect(
			agentOrbState({
				turns: [{ norbital_id: 'turn-1', status: 'running', subagent_id: null }],
				messages: [
					{
						norbital_id: 'message-1',
						parts: [
							{
								role: 'assistant',
								content: '',
								toolCalls: [
									{ id: 'call-1', name: 'write_collection', input: { collection: 'sites' } }
								]
							}
						]
					}
				]
			})
		).toBe('authoring');
		expect(
			agentOrbState({
				turns: [{ norbital_id: 'turn-1', status: 'running', subagent_id: null }],
				messages: [
					{
						norbital_id: 'message-1',
						parts: [
							{
								role: 'assistant',
								content: '',
								toolCalls: [
									{ id: 'call-1', name: 'read_skill', input: { skill: 'norbital-platform' } }
								]
							}
						]
					}
				]
			})
		).toBe('searching');
		expect(agentOrbStatusKey('idle')).toBe('pod.shell.workspaceAgentDescription');
		expect(agentOrbStatusKey('searching')).toBe('pod.agent.searching');
		expect(agentOrbStatusKey('authoring')).toBe('pod.agent.authoring');
		expect(agentOrbBusyStatusKey('idle')).toBe('pod.agent.thinking');
		expect(agentOrbBusyStatusKey('thinking')).toBe('pod.agent.thinking');
		expect(agentOrbBusyStatusKey('working')).toBe('pod.agent.working');
		expect(agentOrbBusyStatusKey('failed')).toBe('pod.agent.failed');
		expect(agentOrbStatusKey('failed')).toBe('pod.agent.failed');
		expect(toolOrbActivity('read_collection')).toBe('searching');
		expect(toolOrbActivity('write_collection')).toBe('authoring');
		expect(toolOrbActivity('list_sandbox_agents')).toBe('searching');
		expect(toolOrbActivity('unknown_tool')).toBe('working');
	});

	it('advances the orb as the replica gains tools, stream tokens, then a finished turn', () => {
		const turn = { norbital_id: 'turn-1', status: 'running', subagent_id: null };
		const user = {
			norbital_id: 'msg-user',
			role: 'user',
			status: 'complete',
			parts: [{ role: 'user', content: 'hey how are u' }]
		};

		expect(agentOrbState({ turns: [turn], messages: [user] })).toBe('thinking');

		expect(
			agentOrbState({
				turns: [turn],
				messages: [
					user,
					{
						norbital_id: 'msg-search',
						role: 'assistant',
						status: 'complete',
						parts: [
							{
								role: 'assistant',
								content: '',
								toolCalls: [{ id: 'call-read', name: 'list_skills', input: {} }]
							}
						]
					}
				]
			})
		).toBe('searching');

		expect(
			agentOrbState({
				turns: [turn],
				messages: [
					user,
					{
						norbital_id: 'msg-search',
						role: 'assistant',
						status: 'complete',
						parts: [
							{
								role: 'assistant',
								content: '',
								toolCalls: [{ id: 'call-read', name: 'list_skills', input: {} }]
							}
						]
					},
					{
						norbital_id: 'msg-search-result',
						role: 'tool',
						status: 'complete',
						parts: [{ role: 'tool', content: '{"skills":[]}', toolCallId: 'call-read' }]
					},
					{
						norbital_id: 'msg-write',
						role: 'assistant',
						status: 'complete',
						parts: [
							{
								role: 'assistant',
								content: '',
								toolCalls: [
									{
										id: 'call-write',
										name: 'write_collection',
										input: { collection: 'projects', action: 'create' }
									}
								]
							}
						]
					}
				]
			})
		).toBe('authoring');

		expect(
			agentOrbState({
				turns: [turn],
				messages: [
					user,
					{
						norbital_id: 'msg-stream',
						role: 'assistant',
						status: 'streaming',
						parts: [{ role: 'assistant', content: 'Workspace inspected' }]
					}
				]
			})
		).toBe('authoring');

		expect(
			agentOrbState({
				turns: [{ ...turn, status: 'succeeded' }],
				messages: [
					user,
					{
						norbital_id: 'msg-final',
						role: 'assistant',
						status: 'complete',
						parts: [{ role: 'assistant', content: 'Workspace inspected and the note was written.' }]
					}
				]
			})
		).toBe('idle');
	});

	it('covers activity states, transitions, and reduced motion', async () => {
		const source = await readFile(orbSourcePath, 'utf8');

		for (const state of ['idle', 'thinking', 'searching', 'authoring', 'working', 'failed']) {
			expect(source).toMatch(new RegExp(`['"]${state}['"]`));
		}
		expect(source).toMatch(/prefers-reduced-motion:\s*reduce/);
		expect(source).toMatch(/const constellationAnchors: ReadonlyArray/);
		expect(source).toMatch(/function buildSphereLayout/);
		expect(source).toMatch(/function searchingSkyPoint/);
		expect(source).toMatch(/const guideIndex/);
		expect(source).toMatch(/let constellationGlow/);
		expect(source).toMatch(/const seedRadius/);
		expect(source).toMatch(/function stateShapeMix/);
		expect(source).toMatch(/function orientStateShape/);
		expect(source).toMatch(/function liveOrbState/);
		expect(source).toMatch(/data-state='failed'/);
		expect(source).toMatch(/data-state=\{state\}/);
		expect(source).toMatch(/requestAnimationFrame/);
		expect(source).not.toMatch(/constellationLinks/);
		expect(source).not.toMatch(/function ribbonPoint/);
	});

	it('is exported and used for identity, tools, and streamed authoring', async () => {
		const [packageSource, panel, transcript, transcriptTs, shell, state] = await Promise.all([
			readFile(packagePath, 'utf8'),
			readFile(panelSourcePath, 'utf8'),
			readFile(transcriptSourcePath, 'utf8'),
			readFile(transcriptTsPath, 'utf8'),
			readFile(shellSourcePath, 'utf8'),
			readFile(orbStatePath, 'utf8')
		]);
		const pkg = JSON.parse(packageSource) as { exports: Record<string, unknown> };

		expect(pkg.exports['./client/agent-orb']).toEqual({
			types: './build/ui/agent/norbital-thinking-orb.svelte.d.ts',
			svelte: './build/ui/agent/norbital-thinking-orb.svelte',
			default: './build/ui/agent/norbital-thinking-orb.svelte'
		});
		expect(panel).toMatch(/NorbitalThinkingOrb[\s\S]*state=\{activityState\}/);
		expect(panel).toMatch(/data-testid="agent-activity-orb"/);
		expect(panel).toMatch(/IconWrapper name="product:pod"/);
		expect(panel).toMatch(/Spinner/);
		expect(panel).toMatch(/AGENT_TURN_STALE_MS/);
		expect(panel).toMatch(/\$effect\(\(\) => \{/);
		expect(panel).not.toContain('{@attach () => {');
		expect(panel).toMatch(/activeSession\.user_id\.length > 0/);
		expect(panel).not.toMatch(/unknown-user/);
		expect(panel).toMatch(/state="failed"/);
		expect(panel).not.toMatch(/NorbitalThinkingOrb state="idle"/);
		expect(transcript).toMatch(/Spinner/);
		expect(transcript).not.toMatch(/NorbitalThinkingOrb/);
		expect(shell).toMatch(/NorbitalThinkingOrb[\s\S]*state=\{fabAgentState\}[\s\S]*size=\{20\}/);
		expect(shell).toMatch(/data-testid="workspace-agent-orb"/);
		expect(shell).toMatch(/data-testid="workspace-agent-shortcut"/);
		expect(shell).toMatch(/onSearch=\{toggleOmniFinder\}/);
		expect(shell).toMatch(/<AgentChatPanel headerOrb=\{false\} \/>/);
		expect(shell).toMatch(/getAgentSurface/);
		expect(shell).toMatch(/composingNew/);
		expect(state).toMatch(/agentOrbBusyStatusKey/);
		expect(shell).toMatch(/workspaceApi\.db\.chat_session\?\.findFirst/);
		expect(state).toMatch(/SEARCH_TOOLS/);
		expect(state).toMatch(/AUTHORING_TOOLS/);
		expect(state).toMatch(/from '\.\/transcript\.js'/);
		expect(transcriptTs).toMatch(/read_skill/);
	});
});
