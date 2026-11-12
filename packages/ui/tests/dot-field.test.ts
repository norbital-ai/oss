import { describe, expect, it } from '@effect/vitest';
import { measureFit, type DotGeometry } from '../src/brand/dot-field.js';
import { accretion_disc_geometry } from '../src/brand/accretion-geometry.js';
import { norbiusStripGeometry } from '../src/brand/norbius-geometry.js';

function bounded_geometry<Seed, State extends string>(geometry: DotGeometry<Seed, State>): void {
	for (const size of [16, 24, 96]) {
		const seeds = geometry.layout(size);
		expect(seeds.length).toBeGreaterThan(0);
		for (const state of geometry.states) {
			const fit = measureFit(geometry, seeds, state);
			expect(Object.values(fit).every(Number.isFinite)).toBe(true);
			expect(fit.scale).toBeGreaterThan(0);
			for (const face of geometry.faces?.(seeds, state) ?? [])
				for (const index of face) {
					expect(Number.isInteger(index)).toBe(true);
					expect(seeds[index]).not.toBeUndefined();
				}
		}
	}
}

describe('dot field geometry', () => {
	it('measures visible particles with their actual seed and stable index', () => {
		const seeds = [{ x: 2, y: 3, vis: 1 }, { x: 6, y: 7, vis: 1 }, { x: 1000, y: 1000, vis: 0 }];
		const visited = new Map<number, (typeof seeds)[number]>();
		const states = new Set<string>();
		const geometry: DotGeometry<(typeof seeds)[number], 'ready'> = {
			states: ['ready'],
			layout: () => seeds,
			point(state, seed, index) {
				visited.set(index, seed);
				states.add(state);
				return { ...seed, z: 0, light: 1, accent: 0, boost: 0 };
			}
		};
		expect(measureFit(geometry, seeds, 'ready')).toEqual({ cx: 4, cy: 5, scale: 0.5 });
		expect([...visited]).toEqual([...seeds.entries()]);
		expect([...states]).toEqual(['ready']);
	});

	it('keeps real mark states finite and every ribbon face within its seed layout', () => {
		bounded_geometry(norbiusStripGeometry);
		bounded_geometry(accretion_disc_geometry);
	});
});
