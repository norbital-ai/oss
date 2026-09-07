/**
 * HOOK_REACH: the hint that lists, per `+hooks.ts`, the collections a hook reads or writes and
 * the relations it nests (RFC 0003 §4, acceptance HA6). Three discriminating observations at
 * least: a hook that reads, a hook that nests, and a hook that does neither and reports nothing.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runRules } from '@norbital-ai/doctor';
import { capabilityPack } from '../build/index.js';

function repository(name: string, files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), `probe-${name}-`));
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), contents);
	}
	execFileSync('git', ['init', '-q'], { cwd: root });
	execFileSync('git', ['add', '-A'], { cwd: root });
	return root;
}

const hooks = (body: string) => `import { Effect } from 'effect';
export default {
	mutate: {
		perRecord: {
			before: {
				description: 'A hook under audit.',
				handler: ({ input, existing, api }) =>
					Effect.gen(function* () {
${body}
					})
			}
		}
	}
};
`;

test('HOOK_REACH lists reads, writes and nested relations per +hooks.ts, and nothing for a hook that nests nothing', (context) => {
	const root = repository('hook-reach', {
		'package.json': '{"name":"hook-reach","type":"module"}',
		// Reads two collections and nests one relation under the returned row.
		'src/collections/employments/+hooks.ts': hooks(`
						const plan = yield* api.db.leave_plans.findFirst({ where: { id: { eq: input.plan_id } } });
						const pending = yield* api.db.leave_requests.findPending({ where: { employment_id: { eq: input.id } } });
						void pending;
						return { ...input, leave_account_employment: [{ id: plan.id, days: 12 }] };`),
		// Writes a sibling collection and spreads a derived graph beside the input.
		'src/collections/employee_children/+hooks.ts': hooks(`
						yield* api.db.employments.mutate([{ id: input.employment_id }]);
						return { ...input, ...(yield* buildGraph(input)) };`),
		// Reads nothing, writes nothing, nests nothing: only its own row.
		'src/collections/leave_types/+hooks.ts': hooks(`
						const row = { ...existing, ...input };
						if (row.account_basis === 'EVENT') refuse('An event type carries no accrual.');
						return { ...input, name: row.name.trim() };`),
		// The same shapes outside a +hooks.ts are not a hook's reach.
		'src/lib/leave/service.ts': `export const plans = (api) => api.db.leave_plans.findMany({});\n`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const findings = runRules({ root, rules: capabilityPack().rules }).filter(
		(finding) => finding.rule === 'HOOK_REACH'
	);
	const byFile = new Map<string, Array<string>>();
	for (const finding of findings) {
		const file = finding.location.split(':')[0] ?? '';
		byFile.set(file, [...(byFile.get(file) ?? []), finding.location]);
	}

	const employments = byFile.get('src/collections/employments/+hooks.ts') ?? [];
	assert.equal(employments.length, 3, `employments: ${employments.join(' | ')}`);
	assert.ok(employments.some((line) => /\$COLLECTION=leave_plans\b/.test(line) && /\$METHOD=findFirst\b/.test(line)));
	assert.ok(employments.some((line) => /\$COLLECTION=leave_requests\b/.test(line) && /\$METHOD=findPending\b/.test(line)));
	assert.ok(employments.some((line) => /\$RELATION=leave_account_employment\b/.test(line)));

	const children = byFile.get('src/collections/employee_children/+hooks.ts') ?? [];
	assert.equal(children.length, 2, `employee_children: ${children.join(' | ')}`);
	assert.ok(children.some((line) => /\$COLLECTION=employments\b/.test(line) && /\$METHOD=mutate\b/.test(line)));
	assert.ok(children.some((line) => /\$SOURCE=yield\* buildGraph\(input\)/.test(line)));

	assert.equal(byFile.get('src/collections/leave_types/+hooks.ts'), undefined, 'a hook that nests nothing reports zero');
	assert.equal(byFile.get('src/lib/leave/service.ts'), undefined, 'a library read is not a hook');
	for (const finding of findings) assert.equal(finding.severity, 'hint');
});
