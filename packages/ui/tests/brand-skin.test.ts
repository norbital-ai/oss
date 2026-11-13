import './dom.ts';
import { readFileSync } from 'node:fs';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from 'vitest';
import { CONCEPT_ICONS, ConceptIcon } from '../src/brand/index.ts';
import IconWrapper from '../src/primitives/icon/icon-wrapper.svelte';

it('every concept renders its own glyph with one accent group, and `Icon` takes it as `concept:<name>`', () => {
	const target = document.body.appendChild(document.createElement('div'));
	try {
		for (const name of Object.keys(CONCEPT_ICONS)) {
			const view = mount(IconWrapper, { target, props: { name: `concept:${name}`, class: 'size-3' } });
			flushSync();
			const svg = target.querySelector(`svg[data-concept-icon="${name}"]`);
			expect(svg?.getAttribute('class')).toBe('size-3');
			expect(svg?.querySelector('g[style*="--product-icon-accent"]')?.children.length).toBeGreaterThan(0);
			unmount(view);
		}
		const view = mount(ConceptIcon, { target, props: { name: 'approvals' } });
		flushSync();
		expect(target.querySelector('svg[data-concept-icon="approvals"]')?.getAttribute('class')).toBe('size-4');
		unmount(view);
	} finally {
		target.remove();
	}
});

it('the map skin drains the basemap differently in light and dark', () => {
	const css = readFileSync(`${import.meta.dirname}/../src/base.css`, 'utf8');
	const token = (block: string) => {
		const body = css.slice(css.indexOf(`${block} {`)).split('\n}')[0] ?? '';
		return body.match(/--map-tiles:\s*([^;]+);/)?.[1];
	};
	const light = token(':root'), dark = token('.dark');
	expect(light).toContain('grayscale(1)');
	expect(dark).toContain('invert(1)');
	expect(css).toMatch(/\.leaflet-tile \{\s*filter: var\(--map-tiles\);/);
});
