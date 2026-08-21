import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { discoverAuthoredSource } from '../../src/compiler/sync.js';

describe('Bolt authored source discovery', () => {
	it('discovers collections, tools, channels, automations, and skills', async () => {
		const root = await mkdtemp(join(tmpdir(), 'bolt-authored-'));
		await mkdir(join(root, 'src', 'collections', 'tickets'), { recursive: true });
		await mkdir(join(root, 'src', 'apps'), { recursive: true });
		await mkdir(join(root, 'src', 'automation'), { recursive: true });
		await mkdir(join(root, 'src', 'channels'), { recursive: true });
		await mkdir(join(root, 'src', 'tools'), { recursive: true });
		await mkdir(join(root, 'src', 'mcp'), { recursive: true });
		await mkdir(join(root, '.agents', 'skills', 'triage'), { recursive: true });
		await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'desk', version: '1.0.0' }));
		await writeFile(join(root, 'src', 'collections', 'tickets', '+model.ts'), 'export default {}');
		await mkdir(join(root, 'src', 'apps', 'desk'), { recursive: true });
		await writeFile(join(root, 'src', 'apps', '+desk.svelte'), '<script></script>');
		await writeFile(
			join(root, 'src', 'apps', 'desk', '+group.ts'),
			"export default group({ label: 'Desk', icon: 'lucide:ticket', defaultChild: 'inbox' });"
		);
		await writeFile(
			join(root, 'src', 'tools', '+summarize.tool.ts'),
			'export default { description: "Summarize" }'
		);
		await writeFile(
			join(root, 'src', 'channels', '+inbox.channel.ts'),
			'export default { name: "inbox" }'
		);
		await writeFile(join(root, 'src', 'automation', '+ticket-opened.ts'), 'export default {}');
		await writeFile(
			join(root, 'src', 'mcp', '+search.mcp.ts'),
			'export default { name: "search", url: "https://mcp.example", tools: ["lookup"] }'
		);
		await writeFile(join(root, '.agents', 'skills', 'triage', 'SKILL.md'), '# Triage');
		const discovered = await Effect.runPromise(discoverAuthoredSource(root));
		expect(discovered.collectionNames).toEqual(['tickets']);
		expect(discovered.appNames).toEqual(['desk']);
		expect(discovered.groupNames).toEqual(['desk']);
		expect(discovered.toolNames).toEqual(['summarize']);
		expect(discovered.envoyNames).toEqual(['inbox']);
		expect(discovered.automationNames).toEqual(['ticket-opened']);
		expect(discovered.mcpServerNames).toEqual(['search']);
		expect(discovered.skillNames).toEqual(['triage']);
	});
});
