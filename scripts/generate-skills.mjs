import {
	existsSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	rmSync,
	symlinkSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Result, Schema } from 'effect';
import { parseDocument } from 'yaml';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const canonicalSkillsRoot = path.join(repositoryRoot, 'skills');
const agentSkillsRoot = path.join(repositoryRoot, '.agents', 'skills');

const SkillFrontmatter = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	license: Schema.optionalKey(Schema.String),
	compatibility: Schema.optionalKey(Schema.String),
	metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
});
const decodeSkillFrontmatter = Schema.decodeUnknownResult(SkillFrontmatter, {
	onExcessProperty: 'error'
});
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const fail = (message) => {
	throw new Error(message);
};

/** Parse one Agent Skills document with YAML owning syntax and Effect owning its shape. */
export const parseSkillMarkdown = (content, filePath) => {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (match === null) fail(`${filePath}: SKILL.md must contain closed YAML frontmatter`);

	const document = parseDocument(match[1], { prettyErrors: true, strict: true, uniqueKeys: true });
	if (document.errors.length > 0) fail(`${filePath}: ${document.errors[0].message}`);
	const decoded = decodeSkillFrontmatter(document.toJS());
	if (Result.isFailure(decoded)) fail(`${filePath}: ${decoded.failure.message}`);

	return {
		frontmatter: decoded.success,
		body: content.slice(match[0].length).replace(/^(\s*\r?\n)+/, '')
	};
};

const validateSkill = ({ frontmatter }, directoryName, filePath) => {
	if (frontmatter.name.trim() === '') fail(`${filePath}: frontmatter requires non-empty name`);
	if (frontmatter.description.trim() === '') {
		fail(`${filePath}: frontmatter requires non-empty description`);
	}
	if (frontmatter.name.length > 64 || !skillNamePattern.test(frontmatter.name)) {
		fail(`${filePath}: name must be lowercase hyphenated and at most 64 characters`);
	}
	if (frontmatter.name !== directoryName) {
		fail(`${filePath}: name "${frontmatter.name}" must match directory "${directoryName}"`);
	}
	if (frontmatter.description.length > 1024) {
		fail(`${filePath}: description exceeds 1024 characters`);
	}
	if ((frontmatter.compatibility?.length ?? 0) > 500) {
		fail(`${filePath}: compatibility exceeds 500 characters`);
	}
};

/** Validate and return the skills delivered directly from the canonical skill tree. */
export const loadSkills = (skillsRoot = canonicalSkillsRoot) => {
	const skills = [];
	for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const { name } = entry;
		const filePath = path.join(skillsRoot, name, 'SKILL.md');
		if (!existsSync(filePath)) fail(`${filePath}: every skill directory requires SKILL.md`);
		const parsed = parseSkillMarkdown(readFileSync(filePath, 'utf8'), filePath);
		validateSkill(parsed, name, filePath);
		skills.push({ name, directory: path.join(skillsRoot, name) });
	}
	return skills.sort((left, right) => left.name.localeCompare(right.name));
};

const expectedLink = (skillsRoot, linksRoot, name) =>
	path.relative(linksRoot, path.join(skillsRoot, name)).split(path.sep).join('/');

/** Prove agent discovery points directly at every canonical skill and nowhere stale. */
export const checkSkillLinks = ({ skills, skillsRoot, linksRoot }) => {
	const expectedNames = new Set(skills.map(({ name }) => name));
	const entries = existsSync(linksRoot) ? readdirSync(linksRoot, { withFileTypes: true }) : [];
	for (const entry of entries) {
		if (!expectedNames.has(entry.name)) fail(`${path.join(linksRoot, entry.name)} is stale`);
		if (!entry.isSymbolicLink())
			fail(`${path.join(linksRoot, entry.name)} must be a symbolic link`);
		const expected = expectedLink(skillsRoot, linksRoot, entry.name);
		if (readlinkSync(path.join(linksRoot, entry.name)) !== expected) {
			fail(`${path.join(linksRoot, entry.name)} must point to ${expected}`);
		}
		expectedNames.delete(entry.name);
	}
	if (expectedNames.size > 0) {
		fail(`${linksRoot} is missing skill links: ${[...expectedNames].sort().join(', ')}`);
	}
};

/** Reconcile only project-owned symlinks; ordinary files are never overwritten. */
export const syncSkillLinks = ({ skills, skillsRoot, linksRoot }) => {
	mkdirSync(linksRoot, { recursive: true });
	const expectedNames = new Set(skills.map(({ name }) => name));
	for (const entry of readdirSync(linksRoot, { withFileTypes: true })) {
		const linkPath = path.join(linksRoot, entry.name);
		if (!entry.isSymbolicLink()) fail(`${linkPath} is not a generated symbolic link`);
		const expected = expectedNames.has(entry.name)
			? expectedLink(skillsRoot, linksRoot, entry.name)
			: undefined;
		if (expected === undefined || readlinkSync(linkPath) !== expected) rmSync(linkPath);
	}
	const linkedNames = new Set(
		readdirSync(linksRoot, { withFileTypes: true }).map(({ name }) => name)
	);
	for (const { name } of skills) {
		if (linkedNames.has(name)) continue;
		symlinkSync(expectedLink(skillsRoot, linksRoot, name), path.join(linksRoot, name), 'dir');
	}
	checkSkillLinks({ skills, skillsRoot, linksRoot });
};

export const main = (argv = process.argv.slice(2)) => {
	const { values } = parseArgs({
		args: argv,
		options: { check: { type: 'boolean', default: false } },
		allowPositionals: false,
		strict: true
	});
	const skills = loadSkills(canonicalSkillsRoot);
	if (values.check) {
		checkSkillLinks({
			skills,
			skillsRoot: canonicalSkillsRoot,
			linksRoot: agentSkillsRoot
		});
		console.log(`Validated ${skills.length} canonical skills and direct agent links.`);
		return;
	}
	syncSkillLinks({ skills, skillsRoot: canonicalSkillsRoot, linksRoot: agentSkillsRoot });
	console.log(`Synchronized ${skills.length} canonical skills for direct agent discovery.`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
