import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	BOLT_TENANT_PUBLIC_PREFIX,
	BOLT_TENANT_REQUEST_PREFIX,
	BOLT_TENANT_STATIC_PREFIX,
	WORKSPACE_ENTRY_FILE_NAME
} from '../../src/compiler/client-entry.js';

const compilerSource = readFileSync(new URL('../../src/compiler/sync.ts', import.meta.url), 'utf8');

describe('public Bolt tenant asset paths', () => {
	it('keeps browser assets under the explicit Bolt namespace on every origin', () => {
		expect(BOLT_TENANT_PUBLIC_PREFIX).toBe('/__bolt');
		expect(BOLT_TENANT_STATIC_PREFIX).toBe('/__bolt/static');
		expect(BOLT_TENANT_REQUEST_PREFIX).toBe('/__bolt/request');
		expect(`${BOLT_TENANT_STATIC_PREFIX}/${WORKSPACE_ENTRY_FILE_NAME}`).toBe(
			'/__bolt/static/workspace.js'
		);
		expect(compilerSource).toContain("build({ root, base: './', mode: 'production'");
	});

	it('embeds authored media at the Bolt tenant request surface with no legacy alias', () => {
		expect(compilerSource).toContain(
			'`${BOLT_TENANT_REQUEST_PREFIX}/api/template-seed-assets/${workspaceKey}/'
		);
		expect(compilerSource).not.toContain('`/api/template-seed-assets/${workspaceKey}/');
	});
});
