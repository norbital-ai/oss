#!/usr/bin/env node
/**
 * `norbital-doctor [root] [--rules <file>] [--rules-only] [--json]`: the audit's one entrypoint, for the sandbox's
 * `audit` job and a repository's CI alike. `--rules` names an organization's rule set (JSON; absent: the platform's
 * defaults). `--json` writes one `AuditEvent` per line and exits 0 once the audit completed, whatever it found; without
 * it the findings and rule errors are printed for a person, and an `error` finding or a rule error exits 1.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Effect, Schema } from 'effect';
import { audit } from './audit.js';
import { DoctorFailure } from './failure.js';
import { DEFAULT_RULE_SET, RuleSet } from './rule-set.js';

const attempt = <A>(work: () => A) =>
	Effect.try({ try: work, catch: (cause) => new DoctorFailure(cause) });
const print = (line: string) => Effect.sync(() => process.stdout.write(`${line}\n`));

const main = Effect.fn('doctor.main')(function* (args: ReadonlyArray<string>) {
	const { values, positionals } = yield* attempt(() =>
		parseArgs({
			args: [...args],
			options: {
				rules: { type: 'string' },
				'rules-only': { type: 'boolean' },
				json: { type: 'boolean' }
			},
			allowPositionals: true
		})
	);
	const file = values.rules;
	const ruleSet =
		file === undefined
			? DEFAULT_RULE_SET
			: yield* attempt(() => readFileSync(file, 'utf8')).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RuleSet)))
				);
	const events = yield* attempt(() =>
		audit({
			root: resolve(positionals[0] ?? '.'),
			ruleSet,
			findings: values['rules-only'] !== true
		})
	);
	if (values.json === true) {
		yield* Effect.forEach(events, (event) => print(JSON.stringify(event)), { discard: true });
		return 0;
	}
	let failed = false;
	for (const event of events)
		if (event.type === 'finding') {
			failed ||= event.severity === 'error';
			yield* print(`${event.severity} ${event.rule} ${event.location} — ${event.summary}`);
		} else if (event.type === 'rule-error') {
			failed = true;
			yield* print(`rule ${event.id} does not compile: ${event.message}`);
		} else if (event.type === 'done')
			yield* print(
				`${event.findings} findings from ${event.rules} rules (doctor ${event.version})`
			);
	return failed ? 1 : 0;
});

if (
	process.argv[1] !== undefined &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
	void Effect.runPromise(
		main(process.argv.slice(2)).pipe(
			Effect.catch((failure) =>
				Effect.sync(() => {
					process.stderr.write(`norbital-doctor: ${failure.message}\n`);
					return 2;
				})
			),
			Effect.tap((code) =>
				Effect.sync(() => {
					process.exitCode = code;
				})
			)
		)
	);
