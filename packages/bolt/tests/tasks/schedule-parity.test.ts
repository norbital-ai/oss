import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActivationCommands } from '../../src/runtime/app.js';
import type { WorkspaceDefinition } from '../../src/authoring/workspace-schema.js';

/**
 * The schedule set, before and after — enumerated on both sides and diffed.
 *
 * This exists because of a failure mode a passing suite cannot see. Every other risk in this change
 * is loud: a protocol mismatch fails to decode, a deleted service breaks its callers. But schedules
 * are changing *owner* — from Colony's `ScheduleRegistry`, fed by `Register` calls carrying
 * `binding.schedule`, to rows the guest writes into its own `bolt_schedule` — and if the new side
 * misses a case the old one caught, the schedule simply stops existing. It raises nothing, fails
 * nothing and logs nothing. A feed quietly stops updating and somebody notices days later.
 *
 * So the proof is a set diff of the schedules themselves, mechanically enumerated on both sides.
 * Not a reading of the two implementations concluding that they agree: reasoning-from-source is how
 * a regex over `+model.ts` silently dropped every generated column and looked plausible doing it.
 *
 * The old implementation below is a **verbatim copy** taken from `d6da04c0`, the last commit before
 * this change. It is not a paraphrase and must not be tidied — its value is entirely that it is the
 * code that actually ran.
 */

const TEMPLATES = join(import.meta.dirname, '../../../../../templates');

/** One cron a template's source actually contains, and where. */
type DeclaredCron = Readonly<{
	readonly template: string;
	readonly kind: 'automation' | 'integration';
	readonly name: string;
	readonly binding: string;
	readonly crontab: string;
}>;

/** Every `schedule: '<cron>'` in a template's authored source, read off disk rather than assumed. */
const declaredCrons = (template: string): ReadonlyArray<DeclaredCron> => {
	const found: Array<DeclaredCron> = [];
	const automations = join(TEMPLATES, template, 'src/automation');
	if (existsSync(automations)) {
		for (const file of readdirSync(automations).filter((entry) => entry.startsWith('+'))) {
			const crontab = /schedule:\s*'([^']+)'/u.exec(readFileSync(join(automations, file), 'utf8'));
			if (crontab?.[1] === undefined) continue;
			found.push({
				template,
				kind: 'automation',
				name: file.replace(/^\+/u, '').replace(/\.ts$/u, ''),
				binding: '',
				crontab: crontab[1]
			});
		}
	}
	const collections = join(TEMPLATES, template, 'src/collections');
	if (existsSync(collections)) {
		for (const collection of readdirSync(collections)) {
			const file = join(collections, collection, '+integrations.ts');
			if (!existsSync(file)) continue;
			const source = readFileSync(file, 'utf8');
			for (const match of source.matchAll(/schedule:\s*'([^']+)'/gu)) {
				const crontab = match[1];
				if (crontab === undefined) continue;
				// Binding names are not recoverable by pattern with any confidence, and they do not need
				// to be: what is under test is that both sides derive the *same* key from the same
				// declaration, so a stable synthetic name serves and a wrong guess would be a wrong guess
				// on both sides equally.
				found.push({
					template,
					kind: 'integration',
					name: `${collection}.erp`,
					binding: 'feed',
					crontab
				});
			}
		}
	}
	return found;
};

/** A workspace definition carrying exactly the declarations found on disk, and nothing invented. */
const workspaceFrom = (crons: ReadonlyArray<DeclaredCron>): WorkspaceDefinition =>
	({
		name: 'parity',
		collections: [],
		customTypes: {},
		policies: [],
		relations: [],
		automations: crons
			.filter((cron) => cron.kind === 'automation')
			.map((cron) => ({
				name: cron.name,
				trigger: { _tag: 'Schedule', cron: cron.crontab },
				command: `automations.${cron.name}`
			})),
		integrations: crons
			.filter((cron) => cron.kind === 'integration')
			.map((cron) => ({
				name: cron.name,
				receive: [{ name: cron.binding, schedule: cron.crontab }],
				send: []
			}))
	}) as unknown as WorkspaceDefinition;

/* eslint-disable */
/**
 * `d6da04c0:packages/bolt/src/runtime/app.ts`, verbatim. Do not edit; do not tidy.
 *
 * Comments stripped only where they described the surrounding file. The logic is untouched.
 */
const OUTBOX_DRAIN_SCHEDULE = '* * * * *';
const oldForWorkspace = (
	workspace: WorkspaceDefinition
): ReadonlyArray<{
	key: string;
	registration: { command: string; schedule: string | null; input: unknown };
}> => {
	const routed = [
		'collections.resume',
		'collections.discard',
		'agents.resume',
		'notifications.drain',
		'integrations.pull',
		'integrations.flush',
		'channels.receive',
		...workspace.automations.map(({ name }) => `automations.${name}`)
	]
		.filter((command, index, commands) => commands.indexOf(command) === index)
		.toSorted()
		.map((command) => ({
			key: command,
			registration: { command, schedule: null as string | null, input: null as unknown }
		}));
	const scheduled = workspace.integrations
		.flatMap((integration) =>
			integration.receive.map((binding) => ({
				key: `integrations.pull:${integration.name}.${binding.name}`,
				registration: {
					command: 'integrations.pull',
					schedule: binding.schedule as string | null,
					input: { name: integration.name, binding: binding.name, cursor: null } as unknown
				}
			}))
		)
		.toSorted((left, right) => left.key.localeCompare(right.key));
	const drained = workspace.integrations
		.filter((integration) => integration.send.length > 0)
		.map((integration) => ({
			key: `integrations.flush:${integration.name}`,
			registration: {
				command: 'integrations.flush',
				schedule: OUTBOX_DRAIN_SCHEDULE as string | null,
				input: { name: integration.name } as unknown
			}
		}))
		.toSorted((left, right) => left.key.localeCompare(right.key));
	return [...routed, ...scheduled, ...drained];
};
/* eslint-enable */

/** What the old registry would have held: every registration that carried a cron, keyed. */
const oldSchedules = (workspace: WorkspaceDefinition): ReadonlyMap<string, string> =>
	new Map(
		oldForWorkspace(workspace)
			.filter((entry) => entry.registration.schedule !== null)
			.map((entry) => [entry.key, entry.registration.schedule as string])
	);

/** What the new activation writes into `bolt_schedule`, keyed the same way. */
const newSchedules = (workspace: WorkspaceDefinition): ReadonlyMap<string, string> =>
	new Map(
		ActivationCommands.schedulesFor(workspace).map((declaration) => [
			declaration.key,
			declaration.crontab
		])
	);

const difference = (
	left: ReadonlyMap<string, string>,
	right: ReadonlyMap<string, string>
): ReadonlyArray<string> => [...left.keys()].filter((key) => !right.has(key)).toSorted();

describe('the schedule set, before and after the owner changed', () => {
	const templates = readdirSync(TEMPLATES, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.toSorted();

	it('finds the crons the templates actually declare, so the diff has something to be about', () => {
		const all = templates.flatMap(declaredCrons);
		// A parity test over an empty set passes vacuously and proves nothing, so this asserts the
		// census is non-trivial before anything is compared. Ten is what the tree holds today; the
		// assertion is a floor rather than an equality so adding a template does not fail it.
		expect(all.length).toBeGreaterThanOrEqual(10);
		expect(new Set(all.map((cron) => cron.template)).size).toBeGreaterThanOrEqual(3);
	});

	for (const template of templates) {
		const crons = declaredCrons(template);
		if (crons.length === 0) continue;

		it(`${template}: every pull schedule survives, key for key and cron for cron`, () => {
			const workspace = workspaceFrom(crons);
			const before = oldSchedules(workspace);
			const after = newSchedules(workspace);
			const pulls = (set: ReadonlyMap<string, string>) =>
				new Map([...set].filter(([key]) => key.startsWith('integrations.pull:')).toSorted());
			// The whole artifact, in one line: same keys, same crontabs, both directions.
			expect(Object.fromEntries(pulls(after))).toEqual(Object.fromEntries(pulls(before)));
		});

		it(`${template}: the only differences are the two that were intended`, () => {
			const workspace = workspaceFrom(crons);
			const before = oldSchedules(workspace);
			const after = newSchedules(workspace);
			// Removed: the fixed per-integration minute drain. It is gone on purpose — a delivery is now
			// enqueued by the write that caused it, and a drain that backs off schedules its own return,
			// so nothing needs to come and look. Every key lost must be one of these.
			expect(difference(before, after).every((key) => key.startsWith('integrations.flush:'))).toBe(
				true
			);
			// Added: automation schedules, which had never fired on any host. `AutomationDeclaration`
			// carried `{ _tag: 'Schedule', cron }`, nothing read it, and the old registry therefore held
			// no key for one. Every key gained must be one of these.
			expect(difference(after, before).every((key) => key.startsWith('automations.'))).toBe(true);
		});

		it(`${template}: every declared automation cron is now a schedule, and none were before`, () => {
			const workspace = workspaceFrom(crons);
			const declared = crons.filter((cron) => cron.kind === 'automation');
			const after = newSchedules(workspace);
			for (const cron of declared) {
				expect(after.get(`automations.${cron.name}`)).toBe(cron.crontab);
			}
			expect(
				[...oldSchedules(workspace).keys()].some((key) => key.startsWith('automations.'))
			).toBe(false);
		});
	}
});
