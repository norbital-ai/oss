import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditAuthoredClientWrappers, auditHooklessMutations } from '../src/quality/audit.js';

/**
 * Proves the onsite-write rule can tell a helper from a handler.
 *
 * Writes (`client.db.*.mutate|delete`, `client.invoke.*`) belong in markup event-handler
 * arrows and `$derived` — positions with no named holder. A named function holding one is
 * the violation. Reads (`findMany`, `pending`) belong in helpers, so both halves are
 * asserted here: the wrappers must fire, and the legitimate shapes must stay silent.
 */
describe('authored client-wrapper audit', () => {
	it('reports a named function wrapping a mutate', () => {
		const source = [
			'<script>',
			"  import { client } from './workspace-client.js';",
			'  function saveLoan() {',
			'    return client.db.loans.mutate([{ id: "1" }]);',
			'  }',
			'</script>',
			'<button>save</button>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([
			{
				file: 'a.svelte',
				line: 4,
				functionName: 'saveLoan',
				call: 'client.db.loans.mutate'
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
			'    return client.db.loans.mutate([]);',
			'  }',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([
			{ file: 'a.svelte', line: 4, functionName: 'seed', call: 'client.db.loans.mutate' }
		]);
	});

	it('reports a wrapper in a .ts lib file', () => {
		const source = [
			"import { client } from './workspace-client.js';",
			'export function saveLoan(input: unknown) {',
			'  return client.db.loans.mutate([input]);',
			'}'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'lib/loans.ts': source })).toEqual([
			{
				file: 'lib/loans.ts',
				line: 3,
				functionName: 'saveLoan',
				call: 'client.db.loans.mutate'
			}
		]);
	});

	it('reports a class method wrapper', () => {
		const source = [
			"import { client } from './workspace-client.js';",
			'export class LoanService {',
			'  async save(input: unknown) {',
			'    return client.db.loans.delete(["1"]);',
			'  }',
			'}'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'lib/service.ts': source })).toEqual([
			{
				file: 'lib/service.ts',
				line: 4,
				functionName: 'save',
				call: 'client.db.loans.delete'
			}
		]);
	});

	it('reports an object method wrapper', () => {
		const source = [
			"import { client } from './workspace-client.js';",
			'export const handlers = {',
			'  async save(input: unknown) {',
			'    return client.db.loans.mutate([input]);',
			'  }',
			'};'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'lib/handlers.ts': source })).toEqual([
			{
				file: 'lib/handlers.ts',
				line: 4,
				functionName: 'save',
				call: 'client.db.loans.mutate'
			}
		]);
	});

	it('sees through a settlement thunk to the named holder', () => {
		const source = [
			'<script>',
			"  import { client } from './workspace-client.js';",
			'  function save() {',
			'    return submit(() => client.db.loans.mutate([{ id: "1" }]));',
			'  }',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([
			{ file: 'a.svelte', line: 4, functionName: 'save', call: 'client.db.loans.mutate' }
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
				'a.svelte': '<button onclick={() => client.db.loans.mutate([{ id: "1" }])}>save</button>'
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
			'    return client.db.loans.pending;',
			'  }',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([]);
	});

	it('does not report a mutate on another client, such as a prop', () => {
		const source = [
			'<script>',
			'  let { operations } = $props();',
			'  function save() {',
			'    return operations.mutate([]);',
			'  }',
			'</script>'
		].join('\n');
		expect(auditAuthoredClientWrappers({ 'a.svelte': source })).toEqual([]);
	});

	it('skips files outside authored source, like the build guard', () => {
		const source = '<script>function s() { return client.db.a.mutate([]); }</script>';
		expect(auditAuthoredClientWrappers({ 'w/node_modules/x.svelte': source })).toEqual([]);
		expect(
			auditAuthoredClientWrappers({ 'w/.norbital/x.ts': 'export function s() { return 1; }' })
		).toEqual([]);
	});
});

/**
 * Proves the hookless-mutation audit lists exactly the mutate grants without hooks.
 *
 * A collection granted `mutate.*` is expected to carry its write effects in
 * `src/collections/<collection>/+hooks.ts`. Read-only grants need no hooks, and a grant
 * with its hooks file present is complete — both stay silent. Fixtures are real workspace
 * trees under a temporary root, because the audit reads the workspace rather than a record
 * of sources.
 */
describe('hookless mutation audit', () => {
	const writeWorkspace = (
		policies: Readonly<Record<string, string>>,
		hooks: ReadonlyArray<string>
	): string => {
		const root = mkdtempSync(join(tmpdir(), 'bolt-hookless-'));
		mkdirSync(join(root, 'src', 'access', 'policies'), { recursive: true });
		for (const [name, content] of Object.entries(policies))
			writeFileSync(join(root, 'src', 'access', 'policies', name), content);
		for (const collection of hooks) {
			mkdirSync(join(root, 'src', 'collections', collection), { recursive: true });
			writeFileSync(join(root, 'src', 'collections', collection, '+hooks.ts'), 'export {};\n');
		}
		return root;
	};

	it('flags a mutate grant with no hooks file', () => {
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
			expect(auditHooklessMutations(root)).toEqual([
				{
					collection: 'loans',
					file: 'src/access/policies/+manager.ts',
					line: 3,
					expectedHooks: 'src/collections/loans/+hooks.ts'
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
			expect(auditHooklessMutations(root)).toEqual([
				{
					collection: 'orders',
					file: 'src/access/policies/+manager.ts',
					line: 3,
					expectedHooks: 'src/collections/orders/+hooks.ts'
				}
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('flags a grantOn mutate and stays silent when the hooks file exists', () => {
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
		const withHooks = writeWorkspace(
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
			expect(auditHooklessMutations(without)).toEqual([
				{
					collection: 'payslips',
					file: 'src/access/policies/+hr.ts',
					line: 3,
					expectedHooks: 'src/collections/payslips/+hooks.ts'
				}
			]);
			expect(auditHooklessMutations(withHooks)).toEqual([]);
		} finally {
			rmSync(without, { recursive: true, force: true });
			rmSync(withHooks, { recursive: true, force: true });
		}
	});

	it('stays silent for read-only and delete-only grants without hooks', () => {
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
			expect(auditHooklessMutations(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('returns nothing when there are no policies', () => {
		const root = mkdtempSync(join(tmpdir(), 'bolt-hookless-'));
		try {
			expect(auditHooklessMutations(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
