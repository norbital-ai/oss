/**
 * A rule id is declared once, or loading fails.
 *
 * `structure.ts` used to load its YAML pack and then filter out every rule whose id a visitor had
 * already claimed. Thirty rule files were parsed, validated against the strict field schema, and
 * discarded: editing one changed nothing, and nothing said so. Two of them had drifted so far from
 * the visitor shadowing them that they reported a different set — `COMPLEX1` counted only `if`
 * where the visitor counts every branching form, and `NODE2` was a whole-file regex with no call
 * graph at all — so the silence was hiding a disagreement, not a duplicate.
 *
 * The filter is gone. These assertions are what replaces it: a second declaration is a thrown
 * error naming the pack, and the shipped packs are proved free of one.
 */
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { definePack, loadPackDirectory, type Rule } from '../build/index.js';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every rule file this repository ships, whichever package declares it. */
function shippedRules(): ReadonlyArray<Rule> {
	const rules: Array<Rule> = [];
	for (const pkg of ['doctor', 'doctor-effect', 'doctor-norbital']) {
		const packs = join(PACKAGES, pkg, 'packs');
		if (!existsSync(packs)) continue;
		for (const entry of readdirSync(packs, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const directory = join(packs, entry.name);
			if (readdirSync(directory).length === 0) continue;
			rules.push(...loadPackDirectory(directory));
		}
	}
	return rules;
}

test('every shipped rule file declares an id no other file declares', () => {
	const seen = new Map<string, string>();
	for (const rule of shippedRules()) {
		const previous = seen.get(rule.id);
		assert.equal(previous, undefined, `rule ${rule.id} is declared twice`);
		seen.set(rule.id, rule.id);
	}
	assert.ok(seen.size > 0, 'no rule files were loaded, so this proves nothing');
});

test('a duplicated id is a thrown error, never a silently dropped rule', () => {
	const [first] = shippedRules();
	assert.ok(first !== undefined);
	assert.throws(
		() => definePack({ name: 'probe', rules: [first, first] }),
		/declares rule .* twice/,
		'a pack declaring one id twice must fail to load'
	);
});

test('no pack directory is present but unloaded', async () => {
	// `packs/platform` existed for seven rules that nothing ever imported: `loadLocalRules` was
	// never called for it, so the TypeScript copy in `platform.ts` was the only one that ran.
	// A directory of rule files that no module loads is the same defect as the filter.
	const { norbitalPack, reactivePack } = await import('@norbital-ai/doctor-norbital');
	const { effectPack, effectCeremonyPack } = await import('@norbital-ai/doctor-effect');
	const { stringlyPack, overlapPack, graphPack } = await import('../build/index.js');
	const loaded = new Set(
		[norbitalPack, reactivePack, effectPack, effectCeremonyPack, stringlyPack, overlapPack, graphPack].flatMap(
			(pack) => pack.rules.map((rule) => rule.id)
		)
	);
	const unreachable = shippedRules()
		.map((rule) => rule.id)
		.filter((id) => !loaded.has(id));
	assert.deepEqual(unreachable, [], 'these rule files are on disk but reach no pack');
});
