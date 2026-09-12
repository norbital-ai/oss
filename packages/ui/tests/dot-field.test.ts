// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RIBBON_BELOW, dotFar, dotNear, measureFit, pitchAcross, pitchAlong } from '../src/dot-field/index.ts';
import { NORBIUS_STRIP_STATES, bandFaces, bandLayout, norbiusStripGeometry } from '../src/norbius-strip/geometry.ts';
import { accretionDiscGeometry, discLayout, discPoint } from '../src/accretion-disc/geometry.ts';

test('a bigger box gets more dots, never bigger ones', () => {
	const sizes = [16, 20, 48, 96, 192];
	const bandCounts = sizes.map((size) => bandLayout(size).length);
	const discCounts = sizes.map((size) => discLayout(size).length);
	for (let i = 1; i < sizes.length; i += 1) {
		assert.ok(bandCounts[i] > bandCounts[i - 1], `band ${sizes[i]}px has more dots than ${sizes[i - 1]}px`);
		assert.ok(discCounts[i] > discCounts[i - 1], `disc ${sizes[i]}px has more dots than ${sizes[i - 1]}px`);
	}
	for (const size of sizes) {
		assert.ok(dotNear(size) <= 1.2, `near dot capped at ${size}px`);
		assert.ok(dotFar(size) <= dotNear(size), `far dot no larger than near at ${size}px`);
	}
});

test('the scale rules are continuous in size — no step between icon and surface sizes', () => {
	for (let size = 16; size < 200; size += 1) {
		for (const rule of [pitchAcross, pitchAlong, dotNear, dotFar]) {
			assert.ok(Math.abs(rule(size + 1) - rule(size)) < 0.05, `${rule.name} steps at ${size}px`);
		}
	}
});

test('every strip state seats inside the unit box, in every direction', () => {
	const seeds = bandLayout(20);
	for (const state of NORBIUS_STRIP_STATES) {
		const fit = measureFit(norbiusStripGeometry, seeds, state);
		for (let time = 0; time < 15; time += 0.6) {
			for (let index = 0; index < seeds.length; index += 1) {
				const point = norbiusStripGeometry.point(state, seeds[index], index, time);
				if (point.vis <= 0) continue;
				const x = (point.x - fit.cx) * fit.scale;
				const y = (point.y - fit.cy) * fit.scale;
				assert.ok(Math.abs(x) <= 1.0001 && Math.abs(y) <= 1.0001, `${state} reaches past the box`);
			}
		}
	}
});

test('at icon size a ribbon of quads spans the two edges, swapped at the seam', () => {
	const seeds = bandLayout(20);
	const { around, across } = seeds;
	assert.ok(20 < RIBBON_BELOW && across >= 3 && across <= 5, 'a few rows, each resolvable');
	const twisted = bandFaces(seeds, 'ready');
	assert.equal(twisted.length, around, 'one quad per ring');
	// Every edge seed is used by exactly two quads, so the surface is closed with no gap.
	const uses = new Map();
	for (const quad of twisted) for (const i of quad) uses.set(i, (uses.get(i) ?? 0) + 1);
	assert.equal(uses.size, around * 2);
	assert.ok([...uses.values()].every((n) => n === 2));
	// The seam: the last ring's edge -v continues into the first ring's edge +v (a Möbius band).
	const last = (around - 1) * across;
	assert.deepEqual(twisted[around - 1], [last, across - 1, 0, last + across - 1]);
	// A flat ring closes onto itself.
	assert.deepEqual(bandFaces(seeds, 'done')[around - 1], [last, 0, across - 1, last + across - 1]);
});

test('a disc dot crosses from the near side to the far side without a jump', () => {
	// A seed placed so that its orbit angle passes through 0 at t = 1: the branch point of the
	// old two-formula placement, where size and draw order used to snap.
	const seed = { kind: 'disc', r: 1.5, phi: -0.55 / 1.5, lower: false };
	const before = discPoint('ready', seed, 0, 0.999);
	const after = discPoint('ready', seed, 0, 1.001);
	assert.ok(Math.abs(before.z - after.z) < 0.01, 'depth is continuous at the crossing');
	assert.ok(Math.abs(before.y - after.y) < 0.01, 'position is continuous at the crossing');
	const fit = measureFit(accretionDiscGeometry, discLayout(96), 'ready');
	assert.ok(fit.scale > 0 && Number.isFinite(fit.scale));
});
