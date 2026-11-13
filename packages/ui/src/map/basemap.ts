// The one basemap every map wears: MapLibre over OpenFreeMap's keyless OpenMapTiles vector tiles, drawn by our own style
// from the design tokens (paper in light, midnight in dark), labelled in Geist. MapLibre loads from its CDN when a map mounts.
import { Effect, type Scope } from 'effect';
import type { Map as MapLibre } from 'maplibre-gl';
import { load_maplibre } from './maplibre.js';

type Style = Exclude<Parameters<MapLibre['setStyle']>[0], string | null>;
type Layer = Style['layers'][number];
type LineLayer = Extract<Layer, { type: 'line' }>;
type Text = NonNullable<NonNullable<Extract<Layer, { type: 'symbol' }>['layout']>['text-field']>;
type Width = NonNullable<NonNullable<LineLayer['paint']>['line-width']>;

/** OpenFreeMap's planet TileJSON (OpenMapTiles schema): keyless, no account, rebuilt weekly behind this one URL. */
const TILES = 'https://tiles.openfreemap.org/planet';
/** Glyphs for what Geist does not cover (CJK, Arabic, …): Protomaps' Noto Sans build, pinned by commit. */
const GLYPHS =
	'https://cdn.jsdelivr.net/gh/protomaps/basemaps-assets@028c18f713baecad011301ff7a69acc39bcc2ae7/fonts/{fontstack}/{range}.pbf';
const GEIST = 'https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/files';
/** The one font stack: Geist draws Latin, the glyphs URL the rest (it serves this stack's name). */
const FONT = 'Noto Sans Regular';
const ATTRIBUTION =
	'<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

/** The tokens drawn: land is the canvas, everything else a step off it; labels muted. */
const PALETTE = {
	// DESIGN.md light: warm cream canvas, warm grays
	light: {
		land: '#f2f1ed',
		park: '#ebeae4',
		water: '#e1e0da',
		building: '#e8e7e1',
		minor: '#e3e2dc',
		road: '#d8d6cf',
		major: '#cdcac2',
		boundary: '#c4c0b8',
		label: '#a39e98',
		place: '#6f6a63'
	},
	// DESIGN.md midnight: carbon land on void water, graphite to smoke roads, ash and fog labels
	dark: {
		land: '#0f1011',
		park: '#121314',
		water: '#08090a',
		building: '#151618',
		minor: '#1b1d20',
		road: '#23252a',
		major: '#2e3136',
		boundary: '#383b3f',
		label: '#62666d',
		place: '#8a8f98'
	}
} as const;

const NAME: Text = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
const width = (z0: number, w0: number, w1: number): Width => [
	'interpolate',
	['exponential', 1.6],
	['zoom'],
	z0,
	w0,
	18,
	w1
];

/** The style for a theme: same layers, the theme's palette. */
export function basemap_style(dark: boolean): Style {
	const c = dark ? PALETTE.dark : PALETTE.light;
	const label = (color: string) => ({ 'text-color': color, 'text-halo-color': c.land, 'text-halo-width': 1.2 });
	const road = (id: string, classes: string[], color: string, z0: number, w1: number): LineLayer => ({
		id,
		type: 'line',
		source: 'base',
		'source-layer': 'transportation',
		minzoom: z0,
		filter: ['in', ['get', 'class'], ['literal', classes]],
		layout: { 'line-cap': 'round', 'line-join': 'round' },
		paint: { 'line-color': color, 'line-width': width(z0, 0.4, w1) }
	});
	return {
		version: 8,
		glyphs: GLYPHS,
		'font-faces': {
			[FONT]: [
				{ url: `${GEIST}/geist-latin-wght-normal.woff2`, 'unicode-range': ['U+0000-00FF', 'U+2000-206F'] },
				{ url: `${GEIST}/geist-latin-ext-wght-normal.woff2`, 'unicode-range': ['U+0100-024F'] }
			]
		},
		sources: { base: { type: 'vector', url: TILES, attribution: ATTRIBUTION } },
		layers: [
			{ id: 'land', type: 'background', paint: { 'background-color': c.land } },
			{
				id: 'park',
				type: 'fill',
				source: 'base',
				'source-layer': 'park',
				paint: { 'fill-color': c.park }
			},
			{
				id: 'green',
				type: 'fill',
				source: 'base',
				'source-layer': 'landcover',
				filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass']]],
				paint: { 'fill-color': c.park, 'fill-opacity': 0.6 }
			},
			{ id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': c.water } },
			{
				id: 'waterway',
				type: 'line',
				source: 'base',
				'source-layer': 'waterway',
				paint: { 'line-color': c.water, 'line-width': width(8, 0.5, 4) }
			},
			{
				id: 'building',
				type: 'fill',
				source: 'base',
				'source-layer': 'building',
				minzoom: 14,
				paint: { 'fill-color': c.building }
			},
			{
				id: 'boundary',
				type: 'line',
				source: 'base',
				'source-layer': 'boundary',
				filter: ['all', ['<=', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
				paint: { 'line-color': c.boundary, 'line-width': 0.6, 'line-dasharray': [3, 2] }
			},
			road('road-minor', ['minor', 'service', 'track'], c.minor, 12, 6),
			road('road', ['secondary', 'tertiary'], c.road, 9, 9),
			road('road-major', ['motorway', 'trunk', 'primary'], c.major, 5, 12),
			{
				id: 'road-name',
				type: 'symbol',
				source: 'base',
				'source-layer': 'transportation_name',
				minzoom: 14,
				layout: {
					'symbol-placement': 'line',
					'text-field': NAME,
					'text-font': [FONT],
					'text-size': 10
				},
				paint: label(c.label)
			},
			{
				id: 'water-name',
				type: 'symbol',
				source: 'base',
				'source-layer': 'water_name',
				layout: { 'text-field': NAME, 'text-font': [FONT], 'text-size': 10, 'text-letter-spacing': 0.1 },
				paint: label(c.label)
			},
			{
				id: 'place-minor',
				type: 'symbol',
				source: 'base',
				'source-layer': 'place',
				minzoom: 11,
				filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter', 'village']]],
				layout: { 'text-field': NAME, 'text-font': [FONT], 'text-size': 10 },
				paint: label(c.label)
			},
			{
				id: 'place',
				type: 'symbol',
				source: 'base',
				'source-layer': 'place',
				filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
				layout: {
					'text-field': NAME,
					'text-font': [FONT],
					'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 12, 13]
				},
				paint: label(c.place)
			},
			{
				id: 'country',
				type: 'symbol',
				source: 'base',
				'source-layer': 'place',
				maxzoom: 7,
				filter: ['==', ['get', 'class'], 'country'],
				layout: {
					'text-field': NAME,
					'text-font': [FONT],
					'text-size': 11,
					'text-transform': 'uppercase',
					'text-letter-spacing': 0.12
				},
				paint: label(c.place)
			}
		]
	};
}

/** Why a map could not draw: MapLibre failed to load, or WebGL is missing. */
export type BasemapFailed = { readonly _tag: 'BasemapFailed'; readonly cause: unknown };

/**
 * A MapLibre map on `node` for the scope, in the page's theme and following it. Rotation and pitch are off; on a coarse
 * pointer one finger never pans, so the page still scrolls past the map (two fingers pinch it).
 */
export const basemap = (
	node: HTMLElement,
	options: { interactive: boolean; center?: [number, number]; zoom?: number }
): Effect.Effect<{ map: MapLibre; maplibre: typeof import('maplibre-gl') }, BasemapFailed, Scope.Scope> =>
	Effect.gen(function* () {
		const maplibre = yield* Effect.tryPromise({
			try: load_maplibre,
			catch: (cause): BasemapFailed => ({ _tag: 'BasemapFailed', cause })
		});
		const dark = () => node.closest('.dark') !== null;
		const map = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					new maplibre.Map({
						container: node,
						style: basemap_style(dark()),
						center: options.center ?? [0, 20],
						zoom: options.zoom ?? 1,
						interactive: options.interactive,
						dragRotate: false,
						touchPitch: false,
						pitchWithRotate: false,
						dragPan: options.interactive && !matchMedia('(pointer: coarse)').matches,
						attributionControl: { compact: true }
					}),
				catch: (cause): BasemapFailed => ({ _tag: 'BasemapFailed', cause })
			}),
			(map) => Effect.sync(() => map.remove())
		);
		map.touchZoomRotate.disableRotation();
		if (options.interactive) map.addControl(new maplibre.NavigationControl({ showCompass: false }));
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				let was = dark();
				const theme = new MutationObserver(() => {
					if (dark() === was) return;
					was = dark();
					map.setStyle(basemap_style(was));
				});
				theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
				return theme;
			}),
			(theme) => Effect.sync(() => theme.disconnect())
		);
		return { map, maplibre };
	});
