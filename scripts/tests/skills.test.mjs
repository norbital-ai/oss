import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
	checkSkillLinks,
	loadSkills,
	parseSkillMarkdown,
	syncSkillLinks
} from '../generate-skills.mjs';

const fixture = () => mkdtempSync(path.join(tmpdir(), 'norbital-skills-'));
const skillMarkdown = (name) => `---
name: ${name}
description: >-
  A folded description for ${name}.
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# ${name}
`;

describe('canonical skill delivery', () => {
	it('delegates YAML parsing and decodes the frontmatter contract', () => {
		const parsed = parseSkillMarkdown(skillMarkdown('sample-skill'), 'sample/SKILL.md');
		assert.equal(parsed.frontmatter.name, 'sample-skill');
		assert.equal(parsed.frontmatter.description, 'A folded description for sample-skill.');
		assert.deepEqual(parsed.frontmatter.metadata, { package: '@norbital-ai/bolt' });
		assert.equal(parsed.body, '# sample-skill\n');
		assert.throws(
			() =>
				parseSkillMarkdown(
					skillMarkdown('sample-skill').replace('license: MIT', 'unknown: value'),
					'sample/SKILL.md'
				),
			/unknown/
		);
	});

	it('links every canonical skill directly and removes stale generated links', (context) => {
		const root = fixture();
		context.after(() => rmSync(root, { recursive: true, force: true }));
		const skillsRoot = path.join(root, 'skills');
		const linksRoot = path.join(root, '.agents', 'skills');
		for (const name of ['alpha-skill', 'beta-skill']) {
			mkdirSync(path.join(skillsRoot, name), { recursive: true });
			writeFileSync(path.join(skillsRoot, name, 'SKILL.md'), skillMarkdown(name));
		}
		mkdirSync(linksRoot, { recursive: true });
		symlinkSync('../../skills/retired-skill', path.join(linksRoot, 'retired-skill'), 'dir');

		const skills = loadSkills(skillsRoot);
		assert.throws(() => checkSkillLinks({ skills, skillsRoot, linksRoot }), /stale/);
		syncSkillLinks({ skills, skillsRoot, linksRoot });
		assert.doesNotThrow(() => checkSkillLinks({ skills, skillsRoot, linksRoot }));
		assert.equal(readlinkSync(path.join(linksRoot, 'alpha-skill')), '../../skills/alpha-skill');
		assert.equal(readlinkSync(path.join(linksRoot, 'beta-skill')), '../../skills/beta-skill');
	});

	it('never overwrites an ordinary agent skill entry', (context) => {
		const root = fixture();
		context.after(() => rmSync(root, { recursive: true, force: true }));
		const skillsRoot = path.join(root, 'skills');
		const linksRoot = path.join(root, '.agents', 'skills');
		mkdirSync(path.join(skillsRoot, 'sample-skill'), { recursive: true });
		mkdirSync(linksRoot, { recursive: true });
		writeFileSync(path.join(skillsRoot, 'sample-skill', 'SKILL.md'), skillMarkdown('sample-skill'));
		writeFileSync(path.join(linksRoot, 'owned-file'), 'do not replace');

		assert.throws(
			() =>
				syncSkillLinks({
					skills: loadSkills(skillsRoot),
					skillsRoot,
					linksRoot
				}),
			/not a generated symbolic link/
		);
	});
});
