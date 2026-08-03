import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from '$lib/skills/types.js';

const state = vi.hoisted(() => ({ workspaceSkills: [] as unknown[] }));

// The two kinds this file is not about are stubbed. Booting a compiled workspace bundle and a
// generated host bundle would prove those pipelines work, which their own suites already do; what is
// under test here is how the three origins merge and what a sandbox contributes to that.
vi.mock('$lib/skills/skills.generated.js', () => ({
	HOST_SKILLS: [
		{
			name: 'norbital-platform',
			description: 'How approvals actually behave.',
			body: 'host body',
			files: [{ path: 'references/approvals.md', text: 'host reference' }],
			origin: 'host'
		}
	]
}));

vi.mock('$lib/server/bootstrap/tenant_workspace.server.js', () => ({
	getTenantWorkspace: () => ({ registered: { skills: state.workspaceSkills } })
}));

const { listSkillSummaries, readSkillContent } = await import('$lib/skills/registry.server.js');

let sandbox: string;
let warnings: string[];

function workspaceSkill(name: string, body: string): Skill {
	return { name, description: `workspace ${name}`, body, files: [], origin: 'workspace' };
}

async function writeSandboxFile(relative: string, contents: string): Promise<void> {
	const file = path.join(sandbox, '.agents', 'skills', relative);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, contents);
}

function skillMarkdown(name: string, body: string): string {
	return `---\nname: ${name}\ndescription: A personal skill called ${name}.\n---\n\n${body}\n`;
}

beforeEach(async () => {
	state.workspaceSkills = [];
	sandbox = await mkdtemp(path.join(tmpdir(), 'pod-personal-skills-'));
	process.env.NORBITAL_POD_SANDBOX_DIR = sandbox;
	warnings = [];
	vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
		warnings.push(String(message));
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	delete process.env.NORBITAL_POD_SANDBOX_DIR;
	await rm(sandbox, { recursive: true, force: true });
});

describe('skill registry', () => {
	it('answers with all three origins in one flat namespace', async () => {
		state.workspaceSkills = [workspaceSkill('site-handover', 'workspace body')];
		await writeSandboxFile('my-notes/SKILL.md', skillMarkdown('my-notes', 'personal body'));

		const summaries = await listSkillSummaries();

		expect(summaries.map((entry) => [entry.name, entry.origin])).toEqual([
			['my-notes', 'personal'],
			['norbital-platform', 'host'],
			['site-handover', 'workspace']
		]);
	});

	it('lets host beat workspace and workspace beat personal on one name', async () => {
		state.workspaceSkills = [
			workspaceSkill('norbital-platform', 'workspace shadow'),
			workspaceSkill('site-handover', 'workspace body')
		];
		await writeSandboxFile(
			'norbital-platform/SKILL.md',
			skillMarkdown('norbital-platform', 'personal shadow')
		);
		await writeSandboxFile(
			'site-handover/SKILL.md',
			skillMarkdown('site-handover', 'personal shadow')
		);

		expect(await readSkillContent('norbital-platform')).toEqual({
			ok: true,
			name: 'norbital-platform',
			path: 'SKILL.md',
			text: 'host body'
		});
		expect(await readSkillContent('site-handover')).toEqual({
			ok: true,
			name: 'site-handover',
			path: 'SKILL.md',
			text: 'workspace body'
		});
		// The losing copy is dropped, not merged: one name, one skill, whichever origin won it.
		const summaries = await listSkillSummaries();
		expect(summaries.map((entry) => [entry.name, entry.origin])).toEqual([
			['norbital-platform', 'host'],
			['site-handover', 'workspace']
		]);
	});

	it('says nothing at all about a sandbox with no skills directory', async () => {
		state.workspaceSkills = [workspaceSkill('site-handover', 'workspace body')];

		const summaries = await listSkillSummaries();

		expect(summaries.map((entry) => entry.name)).toEqual(['norbital-platform', 'site-handover']);
		expect(warnings).toEqual([]);
	});

	it('loses one malformed skill rather than the whole run', async () => {
		await writeSandboxFile('good-notes/SKILL.md', skillMarkdown('good-notes', 'personal body'));
		await writeSandboxFile('broken-frontmatter/SKILL.md', 'no frontmatter here at all\n');
		await writeSandboxFile('mismatched/SKILL.md', skillMarkdown('something-else', 'body'));
		await writeSandboxFile('Not A Skill Name/SKILL.md', skillMarkdown('whatever', 'body'));
		await mkdir(path.join(sandbox, '.agents', 'skills', 'not-a-skill'), { recursive: true });

		const summaries = await listSkillSummaries();

		expect(summaries.map((entry) => entry.name)).toEqual(['good-notes', 'norbital-platform']);
		// The two that were shaped like a skill and got it wrong say so; a directory that is simply not
		// a skill, and a name that could never be one, are not faults worth reporting.
		expect(warnings).toHaveLength(2);
		expect(warnings.join('\n')).toContain('broken-frontmatter');
		expect(warnings.join('\n')).toContain('mismatched');
	});

	it('carries the files beneath a personal skill, and serves them by path', async () => {
		await writeSandboxFile('my-notes/SKILL.md', skillMarkdown('my-notes', 'personal body'));
		await writeSandboxFile('my-notes/references/handover.md', 'the reference');

		const summaries = await listSkillSummaries();
		expect(summaries.find((entry) => entry.name === 'my-notes')?.files).toEqual([
			'references/handover.md'
		]);

		expect(await readSkillContent('my-notes', 'references/handover.md')).toEqual({
			ok: true,
			name: 'my-notes',
			path: 'references/handover.md',
			text: 'the reference'
		});
	});

	it('picks up a skill written after the run started, with no restart', async () => {
		expect((await listSkillSummaries()).map((entry) => entry.name)).toEqual(['norbital-platform']);

		await writeSandboxFile('my-notes/SKILL.md', skillMarkdown('my-notes', 'personal body'));

		expect((await listSkillSummaries()).map((entry) => entry.name)).toEqual([
			'my-notes',
			'norbital-platform'
		]);
	});
});
