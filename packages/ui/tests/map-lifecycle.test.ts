import './dom.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Harness from './map-harness.svelte';
import { viewFixture } from './view-fixture.ts';
import { basemap_style } from '../src/map/basemap.ts';

type Style = { layers: readonly { id: string; paint?: { readonly [property: string]: unknown } }[] };
type Bounds = readonly [readonly [number, number], readonly [number, number]];
// MapLibre at its boundary: happy-dom has no WebGL. Projection is linear (10px a degree) so marks land predictably.
const gl = vi.hoisted(() => {
	const lands: unknown[] = [], fits: unknown[] = [], eased: unknown[] = [];
	const live: { zoom: number; fire: (event: string) => void }[] = [];
	return { maps: 0, removed: 0, zoom: 3, lands, fits, eased, live, inView: false };
});
vi.mock('maplibre-gl', () => {
	const land = (style: Style) => style.layers[0]?.paint?.['background-color'];
	class Map {
		zoom = gl.zoom;
		handlers: { [event: string]: (() => void)[] } = {};
		touchZoomRotate = { disableRotation: () => {} };
		constructor(options: { style: Style }) {
			gl.maps++;
			gl.lands.push(land(options.style));
			gl.live.push(this);
		}
		on(event: string, handler: () => void) {
			(this.handlers[event] ??= []).push(handler);
			return this;
		}
		once(event: string, handler: () => void) {
			return this.on(event, handler);
		}
		fire(event: string) {
			for (const handler of this.handlers[event] ?? []) handler();
		}
		getZoom = () => this.zoom;
		getCenter = () => ({ lng: 0, lat: 0 });
		getBounds = () => ({ contains: () => gl.inView });
		project = ([lng, lat]: [number, number]) => ({ x: lng * 10, y: lat * 10 });
		fitBounds = (bounds: Bounds) => { gl.fits.push(bounds); };
		easeTo = (options: unknown) => { gl.eased.push(options); };
		setStyle = (style: Style) => { gl.lands.push(land(style)); };
		addControl = () => {};
		remove = () => { gl.removed++; };
	}
	class NavigationControl {}
	return { Map, NavigationControl, setWorkerUrl: () => {}, getVersion: () => '6.16.0' };
});
afterEach(() => {
	gl.maps = gl.removed = 0;
	gl.zoom = 3;
	gl.inView = false;
	gl.live.splice(0);
	for (const list of [gl.lands, gl.fits, gl.eased]) list.splice(0);
	document.documentElement.classList.remove('dark');
	history.replaceState(null, '', '/');
});

const catalog = { places: { record_label: 'record.name', label: ['name'], fields: {
	name: { kind: 'text' }, position: { kind: 'point' }, stage: { kind: 'text' }, crew: { kind: 'number' }, note: { kind: 'text' }
} } } as const;
async function mounted(rows: readonly { readonly [field: string]: import('@norbital-ai/store/kind').Value }[], card = false) {
	const { bolt } = await viewFixture({ catalog, read: () => ({ rows: rows.map((row) => ({ stage: '', crew: 0, note: '', ...row })), next: null }) });
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, { target, props: { bolt, card } });
	await vi.waitFor(async () => { flushSync(); await tick(); expect(target.querySelector('[data-map-point], [data-map-cluster]')).not.toBeNull(); });
	return { target, app, close: async () => { await unmount(app); target.remove(); } };
}
const at = (el: Element | null) => el instanceof HTMLElement ? [el.style.left, el.style.top] : null;
const opened = () => new URL(location.href).searchParams.getAll('record');

it('draws marks, routes and overlays over one scoped map and redraws without replacing it', async () => {
	const { target, app, close } = await mounted([{ id: 'place', name: 'Office', position: { lat: 7, lng: 8 } }]);
	try {
		const office = target.querySelector('[data-map-point="place"]');
		expect(at(office)).toEqual(['80px', '70px']);
		expect(office?.textContent?.trim()).toBe('O');
		expect(office?.getAttribute('aria-label')).toBe('Office');
		// the route is drawn twice: its accent glow, then the line
		expect(target.querySelectorAll('svg line')).toHaveLength(2);
		expect(target.querySelector('[data-map-mark]')?.textContent).toContain('Initial destination');
		app.change_overlay();
		flushSync();
		expect(target.querySelector('[data-map-mark]')?.textContent).toContain('Updated destination');
		expect(at(target.querySelector('[data-map-mark]'))).toEqual(['40px', '30px']);
		const route = target.querySelector('[data-map-route]');
		expect([route?.getAttribute('x1'), route?.getAttribute('y1'), route?.getAttribute('x2'), route?.getAttribute('y2')]).toEqual(['60', '50', '40', '30']);
		expect(gl.fits.at(-1)).toEqual([[4, 3], [8, 7]]);
		expect(office?.querySelector('.map-pill')).toBeNull();
		app.always_label();
		flushSync();
		expect(target.querySelector('[data-map-point="place"] .map-pill')?.textContent).toBe('Office');
		target.querySelector<HTMLButtonElement>('[data-map-point="place"]')?.click();
		expect(opened()).toEqual(['places/place']);
		app.disable_clicks();
		flushSync();
		// a static picture: a new map without handlers, its marks inert
		expect(target.querySelector<HTMLButtonElement>('[data-map-point="place"]')?.disabled).toBe(true);
	} finally {
		await close();
	}
	expect(gl.removed).toBe(gl.maps);
});

it('clusters crowded marks into a count that zooms to them and splits as the map zooms in', async () => {
	const { target, close } = await mounted([
		{ id: 'a', name: 'Alpha', position: { lat: 1.3, lng: 103.8 } },
		{ id: 'b', name: 'Bravo', position: { lat: 1.31, lng: 103.81 } },
		{ id: 'c', name: 'Charlie', position: { lat: 1.32, lng: 103.82 } },
		{ id: 'd', name: 'Delta', position: { lat: 51.5, lng: -0.1 } }
	]);
	try {
		const cluster = target.querySelector<HTMLButtonElement>('[data-map-cluster]');
		expect(cluster?.textContent?.trim()).toBe('3');
		expect(target.querySelectorAll('[data-map-point]')).toHaveLength(1);
		const fits = gl.fits.length;
		cluster?.click();
		expect(gl.fits.slice(fits)).toEqual([[[103.8, 1.3], [103.82, 1.32]]]);
		const map = gl.live[0];
		if (map === undefined) throw new Error('No map.');
		map.zoom = 16;
		map.fire('zoom');
		flushSync();
		expect(target.querySelector('[data-map-cluster]')).toBeNull();
		expect(target.querySelectorAll('[data-map-point]')).toHaveLength(4);
	} finally {
		await close();
	}
});

it('selecting a mark or a list row shows its card and outlines the row; a row opens its record', async () => {
	const { target, close } = await mounted([
		{ id: 'a', name: 'Alpha', position: { lat: 30, lng: 10 }, stage: 'Open', crew: 4, note: 'North gate' },
		{ id: 'b', name: 'Bravo', position: { lat: 40, lng: 50 }, stage: 'Done', crew: 2, note: '' }
	], true);
	try {
		expect(target.querySelector('[data-map-card]')).toBeNull();
		expect(target.querySelector('[data-map-point="a"] .map-pill')?.textContent?.trim()).toBe('4');
		target.querySelector('[data-map-point="a"]')?.dispatchEvent(new PointerEvent('pointerenter'));
		flushSync();
		const card = target.querySelector('[data-map-card="a"]');
		expect(card?.querySelector('[data-map-title]')?.textContent).toBe('Alpha');
		expect(card?.textContent).toContain('Open');
		expect(card?.querySelector('[data-map-chip="crew"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Crew4');
		expect(card?.textContent).toContain('North gate');
		expect(target.querySelector('[data-map-row="a"]')?.hasAttribute('data-selected')).toBe(true);
		// from the list: the mark is selected and the map eases to a place out of view
		target.querySelector('[data-map-row="b"]')?.dispatchEvent(new PointerEvent('pointerenter'));
		flushSync();
		expect(target.querySelector('[data-map-card="b"]')).not.toBeNull();
		expect(target.querySelector('[data-map-card="b"]')?.textContent).not.toContain('North gate');
		expect(target.querySelector('[data-map-point="b"]')?.hasAttribute('data-selected')).toBe(true);
		expect(target.querySelector('[data-map-row="a"]')?.hasAttribute('data-selected')).toBe(false);
		expect(gl.eased).toEqual([{ center: [50, 40] }]);
		target.querySelector<HTMLButtonElement>('[data-map-card="b"] button')?.click();
		expect(opened()).toEqual(['places/b']);
		target.querySelector<HTMLButtonElement>('[data-map-row="a"]')?.click();
		expect(opened()).toEqual(['places/b', 'places/a']);
		// a click on the map itself clears the selection
		gl.live[0]?.fire('click');
		flushSync();
		expect(target.querySelector('[data-map-card]')).toBeNull();
	} finally {
		await close();
	}
});

it('draws our own style for each theme and swaps it when the theme changes', async () => {
	const light = basemap_style(false), dark = basemap_style(true);
	expect(dark.layers.map((l) => l.id)).toEqual(light.layers.map((l) => l.id));
	expect(light['font-faces']?.['Noto Sans Regular']).toEqual(expect.arrayContaining([expect.objectContaining({ url: expect.stringContaining('@fontsource-variable/geist@5.3.0') })]));
	const { close } = await mounted([{ id: 'place', name: 'Office', position: { lat: 7, lng: 8 } }]);
	try {
		expect(gl.lands).toEqual(['#f2f1ed']);
		document.documentElement.classList.add('dark');
		await vi.waitFor(() => expect(gl.lands).toEqual(['#f2f1ed', '#0f1011']));
		document.documentElement.classList.remove('dark');
		await vi.waitFor(() => expect(gl.lands).toEqual(['#f2f1ed', '#0f1011', '#f2f1ed']));
	} finally {
		await close();
	}
});
