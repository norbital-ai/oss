import { expect, it } from '@effect/vitest';
import { Layer, ManagedRuntime } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Map from '../../ui/src/map/Map.svelte';
import Harness from '../../ui/tests/view-harness.svelte';
import { scriptedBolt } from '../../ui/tests/scripted-bolt.ts';
import { required } from './support/required.ts';
import './support/shell.css';

// MapLibre (loaded from its CDN) draws in a real WebGL context; the marks, card and list over it are ours. Tiles come from the network and are
// not waited for: a missing tile leaves the marks working.
it('mounts MapLibre on a WebGL canvas, places the marks on it and opens a record from the card', async () => {
	const catalog = {
		sites: {
			record_label: 'record.name',
			label: ['name'],
			fields: { name: { kind: 'text' }, location: { kind: 'point' }, crew: { kind: 'number' } }
		}
	} satisfies Parameters<typeof scriptedBolt>[0]['catalog'];
	const fixture = await scriptedBolt({
		catalog,
		answer: () => ({
			sites: {
				rows: [
					{ id: 'a', name: 'Alpha yard', location: { lat: 1.29, lng: 103.85 }, crew: 4 },
					{ id: 'b', name: 'Bravo depot', location: { lat: 1.35, lng: 103.99 }, crew: 2 }
				],
				next: null,
				total: 2
			}
		})
	});
	// the scripted bolt's reads run on the packaged ui's edge
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	await page.viewport(1200, 900);
	const target = document.createElement('div');
	target.style.cssText = 'padding:24px;background:var(--color-background)';
	document.body.replaceChildren(target);
	const view = mount(Harness, {
		target,
		props: {
			bolt: fixture.bolt,
			catalog,
			part: 'map',
			view: Map,
			props: { of: 'sites', at: 'location', label: 'name', fields: ['crew'], badge: 'crew', list: true, toolbar: false }
		}
	});
	try {
		await expect.poll(() => target.querySelector('canvas.maplibregl-canvas')).not.toBeNull();
		const gl = required(target.querySelector<HTMLCanvasElement>('canvas.maplibregl-canvas'));
		expect(gl.width).toBeGreaterThan(0);
		const frame = required(target.querySelector('[data-map-overlay]')).getBoundingClientRect();
		const box = (id: string) => required(target.querySelector(`[data-map-point="${id}"]`)).getBoundingClientRect();
		// fitted to both: inside the frame, west to east
		await expect.poll(() => box('a').left > frame.left && box('b').right < frame.right && box('a').left < box('b').left).toBe(true);
		await page.getByRole('button', { name: 'Alpha yard' }).first().hover();
		const card = required(target.querySelector('[data-map-card="a"]'));
		expect(card.textContent).toContain('Alpha yard');
		expect(target.querySelector('[data-map-row="a"]')?.hasAttribute('data-selected')).toBe(true);
		await page.getByRole('button', { name: 'Open' }).click();
		expect(new URL(location.href).searchParams.getAll('record')).toEqual(['sites/a']);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
		history.replaceState(null, '', location.pathname);
	}
});
