import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsMatching, walkImportSpecifiers } from '@norbital-ai/test-utilities';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const FORBIDDEN_ISOLATION_FRAGMENTS = [
	'apps/colony',
	'@norbital-ai/colony',
	'templates/hr-payroll',
	'templates/field-operations',
	'templates/crm',
	'templates/construction',
	'templates_private',
	'seed_bank',
	'NORBITAL_SEED_BANK_ROOT'
] as const;

describe('package isolation (T11)', () => {
	it('does not import Colony, product templates, or the private bank', () => {
		const offenders: string[] = [];
		for (const leaf of ['src', 'tests'] as const) {
			const root = path.join(packageRoot, leaf);
			if (!existsSync(root)) continue;
			for (const hit of importsMatching(walkImportSpecifiers(root), FORBIDDEN_ISOLATION_FRAGMENTS)) {
				offenders.push(`${path.relative(packageRoot, hit.file)} -> ${hit.specifier}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
