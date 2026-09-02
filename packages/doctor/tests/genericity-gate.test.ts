/**
 * D11: a repository with no framework, no product config, and no packs still gets a complete
 * health receipt — and names none of those products in its output.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleReport } from '../build/analysis/snapshot.js';
import { computeCheckpointDelta } from '../build/analysis/delta.js';
import { runAuthored } from '../build/authored.js';
import { publishEvidence } from '../build/evidence.js';
import { LANGUAGE_HEALTH_PROFILE } from '../build/health-profile.js';
import { buildMetrics } from '../build/metrics/emitter.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/generic-health', import.meta.url));
const PRODUCT = /svelte|effect|bolt|colony|norbital|drizzle|tenant|workspace|pgTable/i;
const DIAGNOSIS = '.norbital/diagnosis';

function git(cwd: string, args: ReadonlyArray<string>): void {
	execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function materialize(): string {
	const root = mkdtempSync(join(tmpdir(), 'generic-health-'));
	cpSync(FIXTURE, root, { recursive: true });
	git(root, ['init', '-q', '-b', 'main']);
	git(root, ['config', 'user.email', 'gate@test.local']);
	git(root, ['config', 'user.name', 'gate']);
	git(root, ['add', '-A']);
	git(root, ['commit', '-q', '-m', 'checkpoint']);
	return root;
}

function atomicWrite(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, contents);
	renameSync(temporary, path);
}

test('genericity gate: no-framework fixture yields a complete receipt and zero findings', async (context) => {
	const root = materialize();
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const authored = await runAuthored({ root, includeTests: false, paths: [] });
	assert.deepEqual(authored.findings, []);
	assert.deepEqual(authored.packs, []);
	assert.equal(authored.typeAware.ran, true);
	assert.ok(authored.allFiles.length >= 2);

	const metrics = buildMetrics({ root, files: authored.allFiles });
	const metricsPath = join(root, DIAGNOSIS, 'metrics.tsv');
	atomicWrite(metricsPath, metrics.tsv);
	assert.ok(readFileSync(metricsPath, 'utf8').split('\n').length > 2);

	const receipt = publishEvidence({
		root,
		findings: authored.findings,
		authoredRuleSetDigest: authored.ruleSetDigest,
		graph: true,
		typeAware: authored.typeAware.ran,
		allFiles: authored.allFiles,
		selectedFileCount: authored.selectedFiles.length,
		scope: 'all',
		includeTests: false
	});
	assert.equal(receipt.complete, true);
	assert.equal(receipt.tiers.syntactic, true);
	assert.equal(receipt.tiers.graph, true);
	assert.equal(receipt.tiers.typeAware, true);
	assert.ok(receipt.files >= 2);

	const assessed = assembleReport({
		roots: [root],
		receipts: [join(root, DIAGNOSIS, 'receipt.json')],
		requireTypeAware: true,
		format: 'json',
		healthProfile: LANGUAGE_HEALTH_PROFILE
	});
	assert.equal(assessed.exitCode, 0);
	const report = JSON.parse(assessed.json) as {
		totals: { files: number; codeLoc: number; concepts: number; pillars: number };
		scores: Record<string, unknown>;
		distributions: Record<string, { count: number }>;
		concepts: ReadonlyArray<unknown>;
		pillars: ReadonlyArray<unknown>;
		services: ReadonlyArray<unknown>;
		cycles: ReadonlyArray<unknown>;
		colocation: Record<string, unknown>;
		quality: { coverage?: { tiers: { syntactic: boolean; graph: boolean; typeAware: boolean } } } | null;
		verdict?: string;
	};
	assert.ok(report.totals.files >= 2);
	assert.ok(report.totals.codeLoc > 0);
	assert.ok(report.totals.concepts >= 1);
	assert.ok(report.totals.pillars >= 1);
	assert.ok(Object.keys(report.scores).length > 0);
	for (const [name, distribution] of Object.entries(report.distributions)) {
		assert.ok(distribution.count >= 0, name);
	}
	assert.ok(report.concepts.length >= 1);
	assert.ok(report.pillars.length >= 1);
	assert.ok(Array.isArray(report.services));
	assert.ok(Array.isArray(report.cycles));
	assert.ok(report.colocation);
	assert.ok(report.quality?.coverage?.tiers.syntactic);
	assert.ok(report.quality?.coverage?.tiers.graph);
	assert.ok(report.quality?.coverage?.tiers.typeAware);
	assert.ok(report.verdict);

	const delta = computeCheckpointDelta({ root, against: 'HEAD' });
	assert.equal(delta.kind, 'checkpoint-delta');
	assert.ok(delta.pillars.length >= 1);
	assert.ok(delta.totals.disc.files >= 2);

	const scanned = [
		JSON.stringify(authored.findings),
		JSON.stringify({
			kind: receipt.kind,
			scope: receipt.scope,
			tiers: receipt.tiers,
			counts: receipt.counts,
			complete: receipt.complete
		}),
		assessed.json,
		JSON.stringify({
			kind: delta.kind,
			totals: delta.totals,
			pillars: delta.pillars.map(({ pillar }) => pillar)
		})
	]
		.join('\n')
		.replace(/\.norbital\/diagnosis[^\s"]*/g, '');
	const hits = [...scanned.matchAll(new RegExp(PRODUCT.source, 'gi'))].map((match) => match[0] ?? '');
	assert.deepEqual(hits, [], `product vocabulary in output: ${hits.join(', ')}`);
});
