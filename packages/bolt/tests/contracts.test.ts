/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/compiler/discover.ts';
import { load } from '../src/compiler/load.ts';
import { BoltError, callPort, engineManifest } from '../src/engine/contracts.ts';

describe('next engine contracts', () => {
	it('BoltError never throws on construction and keeps its cause (rule 72a)', () => {
		const nasty = { toString() { throw new Error('boom'); } };
		const inner = new BoltError('guest', 'guest', 'inner', new Error('root'));
		for (const message of ['', '   ', 42, nasty, undefined]) {
			const e = new BoltError('x', 'commit', message, inner);
			expect(e.message).toBe('The commit failed.');
			expect(e.cause).toBe(inner);
		}
		expect(((inner.cause as Error).message)).toBe('root');
		expect(new BoltError('refused', 'guest', 'no leave left').message).toBe('no leave left');
	});

	it('callPort turns every port failure into a typed value (L-BOLT-288, 289)', async () => {
		type P = { go(signal: AbortSignal): Promise<number> };
		const go = (p: P, s: AbortSignal) => p.go(s);
		expect(await callPort<P, number>('geo', undefined, 50, go)).toMatchObject({ kind: 'unavailable', facility: 'geo' });
		expect(await callPort<P, number>('geo', { go: () => { throw new Error('sync'); } }, 50, go)).toEqual({ kind: 'upstream', message: 'sync' });
		expect(await callPort<P, number>('geo', { go: () => Promise.reject(new Error('')) }, 50, go)).toEqual({ kind: 'upstream', message: 'geo failed' });
		expect(await callPort<P, number>('geo', { go: () => new Promise(() => {}) }, 20, go)).toMatchObject({ kind: 'timeout' });
		const isNum = (r: unknown): r is number => typeof r === 'number';
		expect(await callPort<P, number>('geo', { go: async () => 'x' as never }, 50, go, isNum)).toMatchObject({ kind: 'upstream' });
		expect(await callPort<P, number>('geo', { go: async () => 7 }, 50, go, isNum)).toBe(7);
	});

	it('engineManifest projects the loaded manifest to data, bodies stripped', async () => {
		const root = fileURLToPath(new URL('./fixtures/good', import.meta.url));
		const { manifest } = await load(root, discover(root).files);
		const m = engineManifest(manifest);
		expect(Object.keys(m.collections).sort()).toEqual(['customers', 'notices', 'orders']);
		expect(m.collections.orders).not.toHaveProperty('bodies');
		expect(m.collections.orders).toHaveProperty('read');
		expect(m.integrations.notices?.direction).toBe('one_way');
		expect(m.workspace.tz).toBeTypeOf('string');
		expect(Object.keys(m.automations)).toEqual(['nightly']);
		expect(m.automations.nightly).toBeDefined();
		expect(m.agent.skills.triage).toContain('description: Triage a notice');
		expect(m.agent.internal).toBeTypeOf('string');
		expect(JSON.parse(JSON.stringify(m.models))).toEqual(m.models);
	});
});
