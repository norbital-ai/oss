/// <reference types="node" />
// The type-cost gate (compute model §5, "Cheaper types, strictness kept"; F28): Bolt's generic row, query and action
// types are what a check spends its time and memory on, so each template's whole-program check stays under a ceiling
// of types and instantiations, measured by TypeScript 7 (`--extendedDiagnostics`) over the realm's template checkouts.
// A change to Bolt's types lowers a ceiling here; one that raises a count fails. Templates the realm has not checked
// out, or not synced (`.norbital/names.ts`), are skipped: the gate runs where the templates are.
// ponytail: whole-program counts only; TypeScript 7 prints no per-file cost, so the most expensive file is not gated.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';

const REALM = fileURLToPath(new URL('../../../../', import.meta.url));
const tsc = join(
	dirname(createRequire(import.meta.url).resolve('@typescript/native-preview/package.json')),
	'bin',
	'tsgo'
);
/** Measured 2026-10-24 after F28 (`MemberWhere`, `Where`, `ModelWhere`), with 5% headroom. hr-payroll was 1.99M types
 * and 3.82M instantiations (29 s) before; 1.03M and 3.06M (1.3 s) after. */
const CEILINGS: {
	readonly [template: string]: { readonly types: number; readonly instantiations: number };
} = {
	construction: { types: 168_300, instantiations: 547_500 },
	'hr-payroll': { types: 1_082_000, instantiations: 3_212_000 }
};
const count = (out: string, label: string) =>
	Number((new RegExp(`^${label}:\\s+([\\d,]+)`, 'm').exec(out)?.[1] ?? 'NaN').replaceAll(',', ''));

for (const [template, ceiling] of Object.entries(CEILINGS)) {
	const target = ['templates', 'templates_private']
		.map((repo) => ({ root: join(REALM, repo, template) }))
		.find(({ root }) => existsSync(join(root, '.norbital', 'names.ts')));
	it.live.skipIf(target === undefined)(
		`${template} checks within ${ceiling.instantiations} instantiations and ${ceiling.types} types`,
		() =>
			Effect.sync(() => {
				if (target === undefined) return;
				const compiled = spawnSync(
					process.execPath,
					[tsc, '-p', join(target.root, 'tsconfig.json'), '--noEmit', '--extendedDiagnostics'],
					{ cwd: target.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
				);
				expect(compiled.error).toBeUndefined();
				expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
				const out = compiled.stdout;
				const measured = {
					types: count(out, 'Types'),
					instantiations: count(out, 'Instantiations')
				};
				expect(measured.types, out).toBeLessThanOrEqual(ceiling.types);
				expect(measured.instantiations, out).toBeLessThanOrEqual(ceiling.instantiations);
			}),
		180_000
	);
}
