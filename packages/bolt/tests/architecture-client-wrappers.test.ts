import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditAuthoredClientWrappers, auditUndeclaredWrites } from '../src/quality/audit.js';

/**
 * Proves the onsite-write rule can tell a helper from a handler.
 *
 * Writes (`client.collection.*.create|update|delete…`, `client.invoke.*`) belong in markup event-handler
 * arrows and `$derived` — positions with no named holder. A named function holding one is
 * the violation. Reads (`findMany`, `pending`) belong in helpers, so both halves are
 * asserted here: the wrappers must fire, and the legitimate shapes must stay silent.
 */
describe('authored client-wrapper audit', () => {
	it('reports a named function wrapping an update', () => {
		const source = [
			'<script>',
			"  import { client } from './workspace-client.js';",
			'  function saveLoan() {',
			'    return client.collection.loans.update("1", { amount: 1 });',
			'  }',
			'</script>',
			'<button>save</button>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([
			{
				file: 'a.svelte',
				line: 4,
				functionName: 'saveLoan',
				call: 'client.collection.loans.update'
			}
		]);
	});

	it('reports a named arrow wrapping an invoke', () => {
		const source = [
			'<script lang="ts">',
			"  import { client } from './workspace-client.js';",
			'  const enroll = async (input: unknown) => {',
			'    return client.invoke.kiosk_enroll(input);',
			'  };',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([
			{
				file: 'a.svelte',
				line: 4,
				functionName: 'enroll',
				call: 'client.invoke.kiosk_enroll'
			}
		]);
	});

	it('reports a wrapper in a module script, not just the instance script', () => {
		const source = [
			'<script context="module">',
			'  import { client } from "./workspace-client.js";',
			'  export function seed() {',
			'    return client.collection.loans.createMany([]);',
			'  }',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([
			{
				file: 'a.svelte',
				line: 4,
				functionName: 'seed',
				call: 'client.collection.loans.createMany'
			}
		]);
	});

	it('reports a wrapper in a .ts lib file', () => {
		const source = [
			"import { client } from './workspace-client.js';",
			'export function saveLoan(input: unknown) {',
			'  return client.collection.loans.create(input);',
			'}'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'lib/loans.ts': source })).toEqual([
			{
				file: 'lib/loans.ts',
				line: 3,
				functionName: 'saveLoan',
				call: 'client.collection.loans.create'
			}
		]);
	});

	it('reports a class method wrapper', () => {
		const source = [
			"import { client } from './workspace-client.js';",
			'export class LoanService {',
			'  async save(input: unknown) {',
			'    return client.collection.loans.delete("1");',
			'  }',
			'}'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'lib/service.ts': source })).toEqual([
			{
				file: 'lib/service.ts',
				line: 4,
				functionName: 'save',
				call: 'client.collection.loans.delete'
			}
		]);
	});

	it('reports an object method wrapper', () => {
		const source = [
			"import { client } from './workspace-client.js';",
			'export const handlers = {',
			'  async save(input: unknown) {',
			'    return client.collection.loans.create(input);',
			'  }',
			'};'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'lib/handlers.ts': source })).toEqual([
			{
				file: 'lib/handlers.ts',
				line: 4,
				functionName: 'save',
				call: 'client.collection.loans.create'
			}
		]);
	});

	it('sees through a settlement thunk to the named holder', () => {
		const source = [
			'<script>',
			"  import { client } from './workspace-client.js';",
			'  function save() {',
			'    return submit(() => client.collection.loans.update("1", { amount: 1 }));',
			'  }',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([
			{ file: 'a.svelte', line: 4, functionName: 'save', call: 'client.collection.loans.update' }
		]);
	});

	it('reports an automation run but not its pending read', () => {
		const source = [
			"import { client } from './workspace-client.js';",
			'export function startRun() {',
			'  return client.automations.nightly.run({});',
			'}'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'lib/auto.ts': source })).toEqual([
			{
				file: 'lib/auto.ts',
				line: 3,
				functionName: 'startRun',
				call: 'client.automations.nightly.run'
			}
		]);
		expect(
			auditAuthoredClientWrappers({
				'lib/auto.ts':
					"import { client } from './w.js';\nexport function status(id: string) {\n  return client.automations.nightly.pending;\n}"
			})
		).toEqual([]);
	});

	it('does not report an inline markup arrow, which is the onsite position', () => {
		expect(
			auditAuthoredClientWrappers({
				'a.svelte':
					'<button onclick={() => client.collection.loans.update("1", { amount: 1 })}>save</button>'
			})
		).toEqual([]);
	});

	it('does not report a derived read, which is where reads belong', () => {
		const source = [
			'<script>',
			'  import { client } from "./w.js";',
			'  let rows = $derived(client.db.loans.findMany({}));',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([]);
	});

	it('does not report a read helper, even a named one', () => {
		const source = [
			'<script>',
			'  import { client } from "./w.js";',
			'  function load() {',
			'    return client.db.loans.findMany({});',
			'  }',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([]);
	});

	it('does not report a pending read in a helper, which is state rather than a write', () => {
		const source = [
			'<script>',
			'  import { client } from "./w.js";',
			'  function isSaving() {',
			'    return client.collection.loans.pending;',
			'  }',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([]);
	});

	it('does not report a write on another client, such as a prop', () => {
		const source = [
			'<script>',
			'  let { operations } = $props();',
			'  function save() {',
			'    return operations.create({});',
			'  }',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([]);
	});

	it('skips files outside authored source, like the build guard', () => {
		const source = '<script>function s() { return client.collection.a.create({}); }</script>';
		expect(auditAuthoredClientWrappers({ 'w/node_modules/x.svelte': source })).toEqual([]);
		expect(
			auditAuthoredClientWrappers({ 'w/.norbital/x.ts': 'export function s() { return 1; }' })
		).toEqual([]);
	});
});

/**
 * Proves the undeclared-write audit lists exactly the mutate grants without a `+collection.ts`.
 *
 * A collection granted `mutate.*` is expected to declare its write contract in
 * `src/collections/<collection>/+collection.ts`. Read-only grants need no declaration, and a
 * grant with its declaration present is complete — both stay silent. Fixtures are real
 * workspace trees under a temporary root, because the audit reads the workspace rather than
 * a record of sources.
 */
describe('undeclared write audit', () => {
	const writeWorkspace = (
		policies: Readonly<Record<string, string>>,
		declared: ReadonlyArray<string>
	): string => {
		const root = mkdtempSync(join(tmpdir(), 'bolt-undeclared-'));
		mkdirSync(join(root, 'src', 'access', 'policies'), { recursive: true });
		for (const [name, content] of Object.entries(policies))
			writeFileSync(join(root, 'src', 'access', 'policies', name), content);
		for (const collection of declared) {
			mkdirSync(join(root, 'src', 'collections', collection), { recursive: true });
			writeFileSync(join(root, 'src', 'collections', collection, '+collection.ts'), 'export {};\n');
		}
		return root;
	};

	it('flags a mutate grant with no +collection.ts', () => {
		const root = writeWorkspace(
			{
				'+manager.ts': [
					"import { grantsOn } from '../../lib/policy_grants.js';",
					'export default {',
					"  grants: grantsOn('loans', ['read', 'mutate.new']),",
					'};'
				].join('\n')
			},
			[]
		);
		try {
			expect(auditUndeclaredWrites(root)).toEqual([
				{
					collection: 'loans',
					file: 'src/access/policies/+manager.ts',
					line: 3,
					expectedDeclaration: 'src/collections/loans/+collection.ts'
				}
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it('inspects literal policy grants and leaves read-only collections alone', () => {
		const root = writeWorkspace(
			{
				'+manager.ts': `export default {
grants: {
  orders: { read: {}, mutate: { new: {} } },
  invoices: { mutate: { existing: {} } },
  countries: { read: {} }
}
};`
			},
			['invoices']
		);
		try {
			expect(auditUndeclaredWrites(root)).toEqual([
				{
					collection: 'orders',
					file: 'src/access/policies/+manager.ts',
					line: 3,
					expectedDeclaration: 'src/collections/orders/+collection.ts'
				}
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('flags a grantOn mutate and stays silent when the declaration exists', () => {
		const without = writeWorkspace(
			{
				'+hr.ts': [
					"import { grantOn } from '../../lib/policy_grants.js';",
					'export default {',
					"  grants: grantOn('payslips', 'mutate.new', {}),",
					'};'
				].join('\n')
			},
			[]
		);
		const withDeclaration = writeWorkspace(
			{
				'+hr.ts': [
					"import { grantOn } from '../../lib/policy_grants.js';",
					'export default {',
					"  grants: grantOn('payslips', 'mutate.new', {}),",
					'};'
				].join('\n')
			},
			['payslips']
		);
		try {
			expect(auditUndeclaredWrites(without)).toEqual([
				{
					collection: 'payslips',
					file: 'src/access/policies/+hr.ts',
					line: 3,
					expectedDeclaration: 'src/collections/payslips/+collection.ts'
				}
			]);
			expect(auditUndeclaredWrites(withDeclaration)).toEqual([]);
		} finally {
			rmSync(without, { recursive: true, force: true });
			rmSync(withDeclaration, { recursive: true, force: true });
		}
	});

	it('stays silent for read-only and delete-only grants without a declaration', () => {
		const root = writeWorkspace(
			{
				'+a.ts': [
					"import { grantsOn } from '../../lib/policy_grants.js';",
					'export default {',
					"  grants: grantsOn('holidays', ['read']),",
					'};'
				].join('\n'),
				'+b.ts': [
					"import { grantsOn } from '../../lib/policy_grants.js';",
					'export default {',
					"  grants: grantsOn('archived', ['delete']),",
					'};'
				].join('\n')
			},
			[]
		);
		try {
			expect(auditUndeclaredWrites(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('returns nothing when there are no policies', () => {
		const root = mkdtempSync(join(tmpdir(), 'bolt-undeclared-'));
		try {
			expect(auditUndeclaredWrites(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
