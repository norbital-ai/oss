import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ImageAsset } from '@norbital-ai/bolt-protocol/facilities';
import {
	assertGuestImageDescriptorsOnly,
	guestImageCommandHasNoBytes,
	IMAGE_DESCRIPTOR_SCHEME,
	userMessageWithImages
} from '../src/runtime/agents/image-descriptors.js';
import { visibleUnsettledAdmission } from '../src/client/ui/agent/admission-reconciliation.js';
import { parseTaskSlashCommand } from '../src/client/ui/agent/intent.js';
import { MCP_PROTOCOL_VERSION, systemToolSpecs } from '../src/runtime/agents/capability-catalog.js';
import { SystemCommandContracts } from '@norbital-ai/bolt-protocol';

const panelSource = readFileSync(
	new URL('../src/client/ui/agent/agent-chat-panel.svelte', import.meta.url),
	'utf8'
);
const intentSource = readFileSync(
	new URL('../src/client/ui/agent/intent.ts', import.meta.url),
	'utf8'
);

describe('G1 immediate user text', () => {
	it('keeps the operator text visible until a durable human message is a live fact', () => {
		const admission = {
			taskId: 'task-1',
			agentId: 'web',
			message: 'Export payroll',
			mode: 'agent' as const,
			priority: 'normal' as const,
			draft: 'Export payroll'
		};
		expect(visibleUnsettledAdmission(admission, new Set())).toEqual(admission);
		expect(visibleUnsettledAdmission(admission, new Set(['other-task']))).toEqual(admission);
		expect(visibleUnsettledAdmission(admission, new Set(['task-1']))).toBeNull();
		expect(panelSource).toContain('data-admission="pending"');
		expect(panelSource).toContain('visibleAdmission.message');
		expect(panelSource).toContain('author.kind === \'human\'');
	});
});

describe('G2 live conversation', () => {
	it('reads Tasks and messages through ordinary live findMany queries', () => {
		expect(panelSource).toContain('runtime.client.db.agent_task.findMany');
		expect(panelSource).toContain('runtime.client.db.agent_message.findMany');
		expect(panelSource).toContain('where: { task_id: { in: activeTaskIds } }');
	});
});

describe('G3 Plan Compact edit and no Goal', () => {
	it('parses only plan and compact, and revises through tasks.editMessage', () => {
		expect(parseTaskSlashCommand('/goal ship it')).toEqual({
			kind: 'message',
			message: '/goal ship it'
		});
		expect(intentSource).not.toMatch(/\/goal/);
		expect(intentSource).toMatch(/\/\(plan\|compact\)/);
		expect(panelSource).toContain('editMessage');
		expect(panelSource).toContain('/compact');
		expect(panelSource).toContain("planMode ? 'plan' : 'agent'");
		expect(panelSource).not.toContain('/goal');
	});
});

describe('G4 skills MCP secrets and models', () => {
	it('exposes inbuilt system tools, MCP 2026 pin, and host-only secret reads', () => {
		expect(systemToolSpecs.map(({ name }) => name)).toEqual(
			expect.arrayContaining(['list_skills', 'read_skill', 'use_image', 'todo'])
		);
		expect(MCP_PROTOCOL_VERSION).toBe('2026-07-28');
		const secrets = SystemCommandContracts.map(({ name }) => name).filter((name) =>
			name.startsWith('secrets.')
		);
		expect(secrets).toEqual(['secrets.status', 'secrets.write']);
		expect(secrets).not.toContain('secrets.read');
	});
});

describe('G5 guest image descriptors', () => {
	it('encodes attach/paste images as descriptors, never guest base64 bytes', () => {
		const asset = ImageAsset.make({
			key: 'agent-tasks/abc/def.jpg',
			name: 'site.jpg',
			mimeType: 'image/jpeg',
			size: 1_042_884
		});
		const message = userMessageWithImages('Look at this', [asset]);
		assertGuestImageDescriptorsOnly(message);
		expect(guestImageCommandHasNoBytes({ taskId: 'task-1', message })).toBe(true);
		expect(JSON.stringify(message)).toContain(IMAGE_DESCRIPTOR_SCHEME);
		expect(JSON.stringify(message)).not.toContain('base64');
		expect(panelSource).toContain('encodeUserMessageWithImages');
		expect(panelSource).toContain('onpaste={onComposerPaste}');
		expect(panelSource).toContain('Attach image');
		expect(panelSource).not.toContain('readAsDataURL');
		expect(panelSource).not.toContain('btoa(');
	});
});
