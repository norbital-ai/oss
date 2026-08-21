import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { boltPlugin } from '../../src/compiler/vite-plugin.js';
import { auditAuthoredSystemColumns, auditImports } from '../../src/quality/audit.js';

/**
 * Proves the boundary audit can fail.
 *
 * `dependencies.test.ts` asserts Bolt's real source produces no findings, which is the property that
 * matters — and which a scanner that never fires would satisfy just as well. These synthetic sources
 * are the positive control: each one is a violation the audit is claimed to catch, so a rule that
 * silently stops matching fails here rather than passing quietly there.
 */
describe('boundary audit', () => {
	it('reports a host framework dependency', () => {
		expect(auditImports({ 'a.ts': "import { Colony } from '@norbital-ai/colony';" })).toEqual([
			{ file: 'a.ts', dependency: '@norbital-ai/colony' }
		]);
	});

	it('reports a provider SDK, including one reached by subpath', () => {
		expect(auditImports({ 'a.ts': "import Stripe from 'stripe';" })).toEqual([
			{ file: 'a.ts', dependency: 'stripe' }
		]);
		expect(auditImports({ 'a.ts': "import { S3 } from '@aws-sdk/client-s3';" })).toEqual([
			{ file: 'a.ts', dependency: '@aws-sdk' }
		]);
	});

	it('reports a listener or process surface Bolt must leave to its host', () => {
		expect(auditImports({ 'a.ts': "import { createServer } from 'node:http';" })).toEqual([
			{ file: 'a.ts', dependency: 'node:http' }
		]);
		expect(auditImports({ 'a.ts': "import { spawn } from 'node:child_process';" })).toEqual([
			{ file: 'a.ts', dependency: 'node:child_process' }
		]);
	});

	it('reports a dynamic import, which a declaration-only scan would miss', () => {
		expect(auditImports({ 'a.ts': "const pg = await import('pg');" })).toEqual([
			{ file: 'a.ts', dependency: 'pg' }
		]);
	});

	it('reports a re-export, which is an import the module graph still carries', () => {
		expect(auditImports({ 'a.ts': "export { Pool } from 'pg';" })).toEqual([
			{ file: 'a.ts', dependency: 'pg' }
		]);
	});

	it('reports ambient host configuration read from the environment', () => {
		expect(auditImports({ 'a.ts': 'export const url = process.env.DATABASE_URL;' })).toEqual([
			{ file: 'a.ts', dependency: 'process.env' }
		]);
	});

	it('does not report process.env named in a comment or a string', () => {
		expect(
			auditImports({
				'a.ts':
					"// Bolt never reads process.env; the host supplies configuration.\nexport const note = 'process.env';"
			})
		).toEqual([]);
	});

	it('does not report a neutral dependency whose name merely starts the same way', () => {
		expect(auditImports({ 'a.ts': "import { effect } from 'pg-format-lite';" })).toEqual([]);
		expect(auditImports({ 'a.ts': "import { Schema } from 'effect';" })).toEqual([]);
	});
});

/**
 * Proves the `norbital_*` rule can tell its two halves apart.
 *
 * The rule is narrow and the temptation is to widen it: a guard that reported every `norbital_*` in
 * authored source would be trivially satisfiable and catastrophically wrong, because filtering on
 * `norbital_approval_id` is how a workspace decides what "live" means, and there are dozens of
 * legitimate predicates, list keys and joins to prove it. So both halves are asserted here — the
 * violations must fire, and the legitimate shapes must stay silent. Half of this suite failing is
 * how a widened rule announces itself before it reaches a tenant's build.
 */
describe('authored system-column audit', () => {
	it('reports the identity a surface hands back to the component that mounted it', () => {
		expect(
			auditAuthoredSystemColumns({
				'a.svelte': '<CollectionForm recordId={record?.norbital_id} />'
			})
		).toEqual([
			{
				file: 'a.svelte',
				line: 1,
				component: 'CollectionForm',
				prop: 'recordId',
				column: 'norbital_id'
			}
		]);
	});

	it('reports an identity smuggled through string interpolation, which no prop type can refuse', () => {
		expect(
			auditAuthoredSystemColumns({
				'a.svelte': '<CollectionTable view={`employees:employments:${record.norbital_id}`} />'
			})
		).toEqual([
			{
				file: 'a.svelte',
				line: 1,
				component: 'CollectionTable',
				prop: 'view',
				column: 'norbital_id'
			}
		]);
	});

	it('reports every system column, not just the primary key', () => {
		const source = [
			'<A a={record.norbital_created_at} />',
			'<B b={record.norbital_updated_at} />',
			'<C c={record.norbital_sys_period} />',
			'<D d={record.norbital_row_version} />',
			'<E e={record.norbital_approval_id} />'
		].join('\n');
		expect(
			auditAuthoredSystemColumns({ 'a.svelte': source }).map(
				({ column, line }) => `${line}:${column}`
			)
		).toEqual([
			'1:norbital_created_at',
			'2:norbital_updated_at',
			'3:norbital_sys_period',
			'4:norbital_row_version',
			'5:norbital_approval_id'
		]);
	});

	it('reports the spellings that route around a property-name check', () => {
		expect(
			auditAuthoredSystemColumns({
				'a.svelte':
					"<A id={String(record.norbital_id)} b={record['norbital_id']} c={record.norbital_id ?? 'none'} d={a ? record.norbital_id : b} />"
			}).map(({ prop }) => prop)
		).toEqual(['id', 'b', 'c', 'd']);
	});

	it('does not report the approval filter the platform is built around', () => {
		expect(
			auditAuthoredSystemColumns({
				'a.svelte':
					'<CollectionTable query={{ where: { norbital_approval_id: { isNull: true } }, orderBy: { norbital_created_at: "desc" }, columns: { norbital_id: true } }} />'
			})
		).toEqual([]);
	});

	it('does not report a predicate that joins on a parent record, or a list key', () => {
		expect(
			auditAuthoredSystemColumns({
				'a.svelte':
					'<CollectionTable query={{ where: { employee_id: { eq: record.norbital_id } } }} />'
			})
		).toEqual([]);
		expect(
			auditAuthoredSystemColumns({
				'a.svelte': '{#each rows as row (row.norbital_id)}<Card />{/each}'
			})
		).toEqual([]);
	});

	it('does not report authored behavior that closes over a record', () => {
		expect(
			auditAuthoredSystemColumns({
				'a.svelte': '<Combobox onValueChange={(value) => select(value, record.norbital_id)} />'
			})
		).toEqual([]);
	});

	it('does not report a plain element, which carries DOM attributes rather than framework props', () => {
		expect(
			auditAuthoredSystemColumns({ 'a.svelte': '<div data-record-id={record.norbital_id}></div>' })
		).toEqual([]);
	});

	it('does not report the whole record, which is the prop the framework asks for', () => {
		expect(
			auditAuthoredSystemColumns({
				'a.svelte': '<CollectionForm defaultValues={record ?? undefined} />'
			})
		).toEqual([]);
	});
});

/**
 * Proves the rule is wired into a build, not merely exported.
 *
 * An audit nothing calls is the same as no audit, and the call site is the part a refactor drops
 * silently — the function keeps its tests and stops running. These assert the plugin reads authored
 * markup, refuses it, and leaves everything that is not authored markup alone.
 */
describe('workspace build guard', () => {
	const plugins = boltPlugin();
	const plugin = (Array.isArray(plugins) ? plugins : [plugins]).find(
		(candidate): candidate is Plugin =>
			typeof candidate === 'object' &&
			candidate !== null &&
			'name' in candidate &&
			candidate.name === '@norbital-ai/bolt'
	);
	const transform = plugin?.transform;
	if (typeof transform !== 'function')
		throw new Error('The Bolt plugin no longer transforms authored source');
	const audit = transform as (this: void, code: string, id: string) => unknown;

	it('fails the build on an authored violation, naming the file, the prop and the column', () => {
		expect(() =>
			audit(
				'<CollectionForm recordId={record?.norbital_id} />',
				'/w/src/collections/employees/+representation.svelte'
			)
		).toThrow(/\+representation\.svelte:1 — <CollectionForm recordId=\{… norbital_id …\}>/);
	});

	it('runs before the Svelte compiler, the last point at which a prop is still a syntactic position', () => {
		expect(plugin?.enforce).toBe('pre');
	});

	it('leaves framework source and non-markup alone', () => {
		expect(
			audit(
				'<CollectionForm recordId={record?.norbital_id} />',
				'/w/node_modules/@norbital-ai/ui/src/x.svelte'
			)
		).toBeNull();
		expect(audit('const id = record.norbital_id;', '/w/src/lib/join.ts')).toBeNull();
	});
});
