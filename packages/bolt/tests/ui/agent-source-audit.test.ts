import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const boltAgent = fileURLToPath(new URL('../../src/client/ui/agent', import.meta.url));

const listSourceFiles = (directory: string): readonly string[] =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return [...listSourceFiles(path)];
		return /\.(?:svelte|ts|js)$/.test(entry.name) ? [path] : [];
	});

describe('agent UI source audit', () => {
	it('does not import @norbital-ai/pod or export pod', () => {
		const files = listSourceFiles(boltAgent);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const source = readFileSync(file, 'utf8');
			expect(source, file).not.toMatch(/from\s+['"]@norbital-ai\/pod(?:\/[^'"]*)?['"]/);
			expect(source, file).not.toMatch(/import\s*\(\s*['"]@norbital-ai\/pod(?:\/[^'"]*)?['"]/);
			expect(source, file).not.toMatch(/export\s+\{[^}]*\bpod\b/);
			expect(source, file).not.toMatch(/export\s+const\s+pod\b/);
		}
	});

	it('drives mailbox controls from sync-backed live collections without polling', () => {
		const panel = readFileSync(join(boltAgent, 'agent-chat-panel.svelte'), 'utf8');
		expect(panel).toContain('runtime.client.db.agent_run.findMany');
		expect(panel).toContain('runtime.client.db.agent_mailbox.findMany');
		expect(panel).toContain('runtime.client.system.agents.dequeue');
		expect(panel).toContain('runtime.client.system.agents.reorder');
		expect(panel).toContain("action: 'interrupt' | 'stop' | 'resume'");
		expect(panel).toContain('runtime.client.system.agents[action]');
		expect(panel).not.toMatch(/setInterval|setTimeout|EventSource|WebSocket/);
	});

	it('reconciles an unknown admission only from its persisted sync projection', () => {
		const panel = readFileSync(join(boltAgent, 'agent-chat-panel.svelte'), 'utf8');
		const send = panel.slice(
			panel.indexOf('function send()'),
			panel.indexOf('function uploadDocument')
		);
		expect(panel).toContain('unsettledAdmission');
		expect(panel).toContain('where: { task_id: { eq: unsettledAdmission.turnId } }');
		expect(panel).toContain('unsettledRunQuery?.current?.some');
		expect(panel).toContain('retryableAdmission(unsettledAdmission');
		expect(panel).toContain('pending: agentWorking');
		expect(panel).toContain('failed: failure != null');
		expect(send.indexOf('session.echo = null')).toBeLessThan(send.indexOf('agentClient.start'));
		expect(send.indexOf('session.echo = admission?.message')).toBeGreaterThan(
			send.indexOf('agentClient.start')
		);
		expect(panel).not.toMatch(/setInterval|setTimeout|EventSource|WebSocket/);
	});

	it('keys the transcript query on a string so sync ticks cannot rebuild it', () => {
		// The id array gets a fresh identity whenever any chat_session row syncs — the agent writes
		// usage totals throughout a turn — and a query derived from that array is torn down and
		// recreated on every tick, so its `current` never leaves `undefined` and the transcript
		// stays blank while the run is live. The string key is what makes streaming parts render.
		const panel = readFileSync(join(boltAgent, 'agent-chat-panel.svelte'), 'utf8');
		expect(panel).toContain(
			"const activeConversationKey = $derived(activeConversationIds.join('\\u0000'))"
		);
		expect(panel).toContain("conversation_id: { in: activeConversationKey.split('\\u0000') }");
		expect(panel).not.toMatch(/conversation_id:\s*\{\s*in:\s*activeConversationIds\s*\}/);
	});

	it('shows queue chrome only when work is actually queued or paused', () => {
		// A lone in-flight turn keeps its interrupt control on the composer; the queue section is
		// reserved for a genuinely non-empty queue, so it never renders as empty chrome over a
		// single running conversation.
		const panel = readFileSync(join(boltAgent, 'agent-chat-panel.svelte'), 'utf8');
		expect(panel).toContain('{#if activeChatId && (mutableRuns.length > 0 || mailboxPaused)}');
		expect(panel).not.toContain('{#if activeChatId && (agentWorking || mailboxPaused)}');
		expect(panel).toContain('{#if runningRun && mutableRuns.length === 0 && !mailboxPaused}');
	});
});
