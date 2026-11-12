import './dom.ts';
import { expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Harness from './map-harness.svelte';
import { viewFixture } from './view-fixture.ts';

type MarkerSnapshot = { at: readonly [number, number]; text: string | null; permanent: boolean; clickable: boolean };
type MapStub = { setView: () => MapStub; remove: () => void; fitBounds: (bounds: unknown) => void; invalidateSize: () => void };
type TileStub = { on: () => TileStub; addTo: () => TileStub };
type GroupStub = { addTo: () => GroupStub; clearLayers: () => void };
type MarkerStub = { addTo: () => MarkerStub; bindTooltip: (text: string, options: { permanent?: boolean }) => MarkerStub; on: () => MarkerStub };
const leaflet = vi.hoisted(() => {
	const markers: MarkerSnapshot[] = [], lines: unknown[] = [], fits: unknown[] = [];
	return { maps: 0, removed: 0, clears: 0, markers, lines, fits };
});
vi.mock('leaflet', () => ({
	Browser: { mobile: false },
	map: () => {
		leaflet.maps++;
		const map: MapStub = {
			setView: () => map,
			remove: () => { leaflet.removed++; },
			fitBounds: (bounds: unknown) => { leaflet.fits.push(bounds); },
			invalidateSize: () => {}
		};
		return map;
	},
	tileLayer: () => {
		const layer: TileStub = { on: () => layer, addTo: () => layer };
		return layer;
	},
	layerGroup: () => {
		const layer: GroupStub = {
			addTo: () => layer,
			clearLayers: () => { leaflet.clears++; leaflet.markers.splice(0); leaflet.lines.splice(0); }
		};
		return layer;
	},
	circleMarker: (at: readonly [number, number]) => {
		const data: MarkerSnapshot = { at, text: null, permanent: false, clickable: false };
		leaflet.markers.push(data);
		const marker: MarkerStub = {
			addTo: () => marker,
			bindTooltip: (text: string, options: { permanent?: boolean }) => { data.text = text; data.permanent = options.permanent === true; return marker; },
			on: () => { data.clickable = true; return marker; }
		};
		return marker;
	},
	polyline: (points: unknown) => { leaflet.lines.push(points); return { addTo: () => {} }; },
	latLngBounds: (points: unknown) => points
}));

it('redraws changed overlay values and marker options without replacing the scoped map', async () => {
	leaflet.maps = leaflet.removed = leaflet.clears = 0;
	leaflet.markers.splice(0); leaflet.lines.splice(0); leaflet.fits.splice(0);
	const { bolt } = await viewFixture({
		catalog: { places: { record_label: 'record.name', label: ['name'], fields: { name: { kind: 'text' }, position: { kind: 'point' } } } },
		read: () => ({ rows: [{ id: 'place', name: 'Office', position: { lat: 7, lng: 8 } }], next: null }) });
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, { target, props: { bolt } });
	try {
		await vi.waitFor(async () => { flushSync(); await tick(); expect(leaflet.markers).toHaveLength(2); });
		expect(leaflet.maps).toBe(1);
		expect(leaflet.markers).toContainEqual({ at: [7, 8], text: 'Office', permanent: false, clickable: true });
		app.change_overlay();
		flushSync();
		expect(leaflet.markers).toContainEqual({ at: [3, 4], text: 'Updated destination', permanent: false, clickable: false });
		expect(leaflet.lines).toEqual([[[5, 6], [3, 4]]]);
		app.always_label();
		flushSync();
		expect(leaflet.markers).toContainEqual({ at: [7, 8], text: 'Office', permanent: true, clickable: true });
		app.disable_clicks();
		flushSync();
		expect(leaflet.markers).toContainEqual({ at: [7, 8], text: 'Office', permanent: true, clickable: false });
		expect(leaflet.maps).toBe(1);
		expect(leaflet.fits.at(-1)).toEqual([[7, 8], [3, 4]]);
	} finally {
		await unmount(app);
		target.remove();
	}
	expect(leaflet.removed).toBe(1);
	const draws = leaflet.clears;
	await tick();
	expect(leaflet.clears).toBe(draws);
});
