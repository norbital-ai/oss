import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentOrbState } from '../../src/ui/agent/agent-orb-state.js';

const podRoot = process.cwd();
const orbSourcePath = resolve(podRoot, 'src/ui/agent/norbital-thinking-orb.svelte');
const orbStatePath = resolve(podRoot, 'src/ui/agent/agent-orb-state.ts');
const panelSourcePath = resolve(podRoot, 'src/ui/agent/agent-chat-panel.svelte');
const transcriptSourcePath = resolve(podRoot, 'src/ui/agent/agent-transcript-item.svelte');
const shellSourcePath = resolve(podRoot, 'src/ui/shell/pod-shell.svelte');
const packagePath = resolve(podRoot, 'package.json');

describe('Norbital agent orb', () => {
	it('derives live activity from the durable session aggregate', () => {
		expect(agentOrbState({})).toBe('idle');
		expect(agentOrbState({ pending: true })).toBe('thinking');
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
	});

	it('covers activity states, transitions, and reduced motion', async () => {
		const source = await readFile(orbSourcePath, 'utf8');

		for (const state of ['idle', 'thinking', 'searching', 'authoring', 'working']) {
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
		expect(source).toMatch(/requestAnimationFrame/);
		expect(source).not.toMatch(/constellationLinks/);
		expect(source).not.toMatch(/function ribbonPoint/);
	});

	it('is exported and used for identity, tools, and streamed authoring', async () => {
		const [packageSource, panel, transcript, shell, state] = await Promise.all([
			readFile(packagePath, 'utf8'),
			readFile(panelSourcePath, 'utf8'),
			readFile(transcriptSourcePath, 'utf8'),
			readFile(shellSourcePath, 'utf8'),
			readFile(orbStatePath, 'utf8')
		]);
		const pkg = JSON.parse(packageSource) as { exports: Record<string, unknown> };

		expect(pkg.exports['./client/agent-orb']).toEqual({
			types: './build/ui/agent/norbital-thinking-orb.svelte.d.ts',
			svelte: './build/ui/agent/norbital-thinking-orb.svelte',
			default: './build/ui/agent/norbital-thinking-orb.svelte'
		});
		expect(panel).toMatch(/NorbitalThinkingOrb state="idle"/);
		expect(panel).toMatch(/NorbitalThinkingOrb state="thinking"/);
		expect(transcript).toMatch(/toolOrbState/);
		expect(transcript).toMatch(/state="authoring"/);
		expect(shell).toMatch(/NorbitalThinkingOrb[\s\S]*state=\{fabAgentState\}[\s\S]*size=\{20\}/);
		expect(shell).toMatch(/workspaceApi\.db\.chat_session\?\.findFirst/);
		expect(state).toMatch(/SEARCH_TOOLS/);
		expect(state).toMatch(/AUTHORING_TOOLS/);
	});
});
