import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { FixedCommandCatalogue, type FixedCommandName } from '@norbital-ai/bolt-protocol';
import { FixedCommandBindings } from '../../src/runtime/commands.js';

describe('command catalogue cutover', () => {
	it('has exactly one binding for every protocol-owned fixed contract', () => {
		const contracts = FixedCommandCatalogue.map(({ name }) => name);
		const bindings = [...FixedCommandBindings.keys()];
		expect(new Set(contracts).size).toBe(contracts.length);
		expect(new Set(bindings).size).toBe(bindings.length);
		expect(bindings.sort()).toEqual(contracts.sort());
	});

	/**
	 * The collection one-shots a board issues by name, rather than left to the set equality above.
	 * `collections.count` is what `countQueryOf` calls for "1 of 335"; `collections.findGrouped` is
	 * what the kanban lanes call; `collections.findMany` / `collections.findFirst` are the deep
	 * `after` pages. A caller of a contract nothing binds gets `unknown_command` at run time with
	 * nothing failing at build time.
	 */
	it('binds the collection query commands the browser client calls by name', () => {
		for (const name of [
			'collections.export',
			'collections.count',
			'collections.findMany',
			'collections.findFirst',
			'collections.findGrouped'
		]) {
			expect(FixedCommandCatalogue.map((contract) => contract.name)).toContain(name);
			expect(FixedCommandBindings.has(name), name).toBe(true);
			expect(
				FixedCommandBindings.get(name)?.contract.responses.map(({ status }) => status)
			).toEqual([200]);
		}
	});

	it('declares every origin and response boundary in metadata', () => {
		for (const binding of FixedCommandBindings.values()) {
			expect(Object.keys(binding.origins).length, binding.contract.name).toBeGreaterThan(0);
			for (const rule of Object.values(binding.origins)) {
				expect(rule?.authorization.length, binding.contract.name).toBeGreaterThan(0);
			}
			expect(binding.contract.responses.length, binding.contract.name).toBeGreaterThan(0);
		}
	});

	it('contains no obsolete agent API, switch dispatcher, or duplicate client path', () => {
		const names = FixedCommandCatalogue.map(({ name }) => name);
		expect(names).not.toContain('agents.enqueue');
		expect(names).not.toContain('agents.updateVerifier');
		expect(names).not.toContain('identity.authenticate');

		const dispatch = readFileSync(
			new URL('../../src/runtime/dispatch.ts', import.meta.url),
			'utf8'
		);
		expect(dispatch).not.toMatch(/\bcase\s+['"]/u);
		expect(dispatch).not.toContain('Schema.Struct(');

		const paths = FixedCommandCatalogue.flatMap((contract) =>
			'clientPath' in contract && contract.clientPath !== undefined
				? [contract.clientPath.join('.')]
				: []
		);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it('does not admit an unbound collection read name into the fixed command union', () => {
		expectTypeOf<'collections.findMany'>().toExtend<FixedCommandName>();
		expectTypeOf<'collections.findFirst'>().toExtend<FixedCommandName>();
		expectTypeOf<'collections.unboundFind'>().not.toExtend<FixedCommandName>();
	});
});
