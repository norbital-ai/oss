import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const tabsSource = readFileSync(resolve('../ui/src/tabs/tabs.svelte'), 'utf8');
const reclamationProjects = readFileSync(
	resolve('../../template_workspaces/reclamation/src/apps/+reclamation_projects.svelte'),
	'utf8'
);
const reclamationCostMatrix = readFileSync(
	resolve('../../template_workspaces/reclamation/src/apps/+reclamation_cost_matrix.svelte'),
	'utf8'
);

function svelteFilesUnder(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) return svelteFilesUnder(path);
		return entry.isFile() && entry.name.endsWith('.svelte') ? [path] : [];
	});
}

describe('workspace tab composition', () => {
	it('uses the default tab treatment and aligns its list with the shared content inset', () => {
		expect(tabsSource).toContain("variant = 'default'");
		expect(tabsSource).toContain(
			"variant === 'default' ? cn(INSET_MX_CLASS, 'w-auto') : undefined"
		);
	});

	it('keeps Reclamation pages and every authored template on the canonical default variant', () => {
		expect(reclamationProjects).not.toContain('variant="underline"');
		expect(reclamationCostMatrix).not.toContain('variant="underline"');

		for (const template of readdirSync(resolve('../../template_workspaces'), {
			withFileTypes: true
		})) {
			if (!template.isDirectory()) continue;
			for (const file of svelteFilesUnder(
				resolve('../../template_workspaces', template.name, 'src')
			)) {
				expect(readFileSync(file, 'utf8'), file).not.toContain('variant="underline"');
			}
		}
	});
});
