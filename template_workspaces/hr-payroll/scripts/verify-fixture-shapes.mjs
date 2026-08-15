// fallow-ignore-file unused-file -- Standalone fixture-shape gate invoked from the payroll README.

/**
 * Fixture-shape verification for the payroll engine.
 *
 * ```
 * cd template_workspaces/hr-payroll
 * node scripts/verify-fixture-shapes.mjs
 * ```
 *
 * ## What this exists to catch
 *
 * `verify-payroll-arithmetic.mjs` hand-builds its fixtures. A hand-built fixture can drift from the
 * shape the engine actually reads, and when it does the assertion above it stops meaning anything:
 * the engine reads `undefined`, takes a branch nobody intended, and the check either passes for the
 * wrong reason or fails for a reason that looks like an arithmetic bug.
 *
 * The case that prompted this: a claim fixture carried `nature` on an invented `componentType`
 * sub-object while `settle()` reads `payComponent.nature`. `payments` summed to zero and a
 * payroll-settled reimbursement never reached net.
 *
 * ### Where a shape like that comes from
 *
 * `component_types` and `payslip_line_sources` were once real collections. They are gone from
 * `src/collections/`, but they survive in build artefacts that are not regenerated on delete —
 * `.norbital/dist/`. A fixture written by reading a stale
 * artefact describes an API that no longer exists, and nothing in a normal build says so. Expect
 * this failure mode to recur; check the live model under `src/collections/<name>/+model.ts`, not a
 * generated index.
 *
 * ## The two detectors
 *
 * **A — required field absent (runtime).** Runs `verify-payroll-arithmetic.mjs` with every argument
 * to every payroll-engine function deep-proxied, and records each read of a key the fixture does not
 * have. On the case above it reports
 * `settle.settle(arg0).lines.0.payComponent.nature`, naming the field and the line.
 *
 * **B — surplus field present (static).** Flags object keys in the target script that appear nowhere
 * in `src/`. On the case above it reports `componentType`, since that name exists nowhere in the
 * template.
 *
 * ## How to trust a green run
 *
 * A checker that reports nothing is indistinguishable from a checker that sees nothing, and this one
 * has already been both. Its first version bound array methods to the raw target, so `lines.reduce`
 * handed the engine unproxied elements and detector A could not see below any array — which is to
 * say it was blind to the exact bug it was written for, while still printing a clean sheet.
 *
 * That was caught by mutation, and mutation is how to re-establish trust after any change here:
 * put the defect back, confirm both detectors go red and the exit code is 1, then restore.
 *
 * ```
 * # in claimLine, move `nature` back onto an invented `componentType` sub-object
 * node scripts/verify-fixture-shapes.mjs; echo EXIT=$?   # expect EXIT=1 and both detectors red
 * ```
 *
 * Do not treat a green run as evidence until that has been done at least once against the change
 * being made. Detector A's reach in particular is easy to shrink to nothing by accident.
 *
 * ## What it can and cannot see
 *
 * Detector A sees:
 * - reads of any depth up to 6 on plain objects and arrays reached from an argument to an exported
 *   function of a `lib/*.ts` module that the target script loads.
 *
 * Detector A cannot see:
 * - **optional reads.** A proxy cannot tell `options.rule` from `options.rule?.authority`, so a
 *   legitimately-absent optional field looks identical to a missing required one. This is not
 *   filtered automatically; it is filtered by the hand-curated `KNOWN_ABSENT` baseline below, which
 *   is human judgement and can be wrong.
 * - anything inside a `Date`, `Map`, `Set`, `RegExp`, `Promise` or `Error` — proxying those changes
 *   real behaviour, so they are passed through untouched. Fixtures keyed by `Map` (the holiday and
 *   shift catalogues) are therefore only checked at their surface.
 * - fields read below depth 6, or on values the engine constructs itself rather than receives.
 * - a fixture that supplies a field of the right name but the wrong *type* — `number` where the
 *   engine expects `{ value, currency }` reads fine and is invisible here.
 * - anything on a code path the target script never exercises. Coverage is exactly the target's
 *   coverage, no more.
 *
 * Detector B cannot see:
 * - a surplus key whose name happens to occur anywhere in `src/` for an unrelated reason. It is a
 *   name-existence test, not a type check, so it under-reports and never over-reports.
 *
 * ## Exit code
 *
 * Non-zero only on findings outside the baseline, so this can gate. It also exits non-zero if the
 * target script fails to run to completion, because a partial run is a partial audit and reporting
 * "no findings" from one would be the exact dishonesty this check exists to prevent.
 *
 * A target-script *assertion* failure does not by itself fail this check — that is
 * `verify-payroll-arithmetic.mjs`'s job to report — but the count is echoed below, and a count that
 * differs from a plain run means the instrumentation perturbed behaviour and the run is suspect.
 *
 * ## Should this be in `pnpm test`?
 *
 * Yes, and so should its target. `verify-payroll-arithmetic.mjs` is on-demand and absent from
 * `pnpm test`, which is why the `componentType` fixture was able to rot unnoticed. This check is
 * strictly cheaper than the reason it exists.
 */

import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const targetPath = path.join(here, 'verify-payroll-arithmetic.mjs');
const probePath = path.join(here, 'fixture-shape-probe.mjs');

/**
 * Detector A findings that are known-good optional reads, each with the reason it is absent.
 *
 * Every entry here is a claim that the engine reads this field defensively and absence is correct.
 * Adding a line to silence a red run — rather than because the read is genuinely optional — puts
 * back the exact blind spot this script was written to remove.
 */
const KNOWN_ABSENT = new Map([
	[
		'leave.unpaidLeaveInWindow(arg0).month',
		'Declared `month?:` (leave.ts:325) and null-checked before use — absence means "no extended-absence month".'
	],
	[
		'leave.unpaidLeaveInWindow(arg0).extendedDates',
		'Declared `extendedDates?:` (leave.ts:327) and defaulted with `?? new Set()` (leave.ts:332).'
	],
	[
		'settlement.readSettlementPolicy(arg0).settlement_policy',
		'Declared `settlement_policy?:` (settlement.ts:115); `if (stored == null) return PLAIN_CALENDAR` is the documented no-policy path.'
	]
]);

/** Detector B keys that are not engine fields at all, with the reason each is exempt. */
const NOT_ENGINE_FIELDS = new Map([
	['configFile', 'Vite `createServer` option, not a payroll field.'],
	['logLevel', 'Vite `createServer` option, not a payroll field.'],
	// The rest-day/public-holiday overtime split checks build a summary object to compare against a
	// literal. These names label that summary on both the actual and the expected side; they are the
	// target script's own vocabulary and never reach the engine.
	['overtimeDayWageUnits', 'Local label in the priceDay split summary, used on both sides.'],
	['overtimeHourlyHours', 'Local label in the priceDay split summary, used on both sides.'],
	['incentiveDayWageUnits', 'Local label in the priceDay split summary, used on both sides.'],
	['incentiveHourlyHours', 'Local label in the priceDay split summary, used on both sides.'],
	['incentiveHourlyUnits', 'Local label in the priceDay split summary, used on both sides.']
]);

// ── Detector B: surplus fields ──────────────────────────────────────────────────────────────────

function sourceFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(full));
		else if (/\.(ts|svelte)$/.test(entry.name)) out.push(full);
	}
	return out;
}

function surplusFields(targetSource) {
	const corpus = sourceFiles(path.join(root, 'src'))
		.map((file) => fs.readFileSync(file, 'utf8'))
		.join('\n');
	const lines = targetSource.split('\n');
	const seen = new Map();
	lines.forEach((line, index) => {
		const match = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(line);
		if (!match) return;
		const key = match[1];
		if (NOT_ENGINE_FIELDS.has(key)) return;
		if (new RegExp(`\\b${key}\\b`).test(corpus)) return;
		if (!seen.has(key)) seen.set(key, []);
		seen.get(key).push(index + 1);
	});
	return seen;
}

// ── Detector A: absent required fields ──────────────────────────────────────────────────────────

register(pathToFileURL(probePath), {
	parentURL: import.meta.url,
	data: { targetUrl: pathToFileURL(targetPath).href, probeUrl: pathToFileURL(probePath).href }
});

console.log('Running verify-payroll-arithmetic.mjs under fixture-shape instrumentation…\n');

let targetCompleted = true;
let targetFailure = null;
try {
	await import(pathToFileURL(targetPath).href);
} catch (error) {
	targetCompleted = false;
	targetFailure = error;
}

const targetAssertionsFailed = process.exitCode === 1;
process.exitCode = 0;

const runtimeFindings = [...(globalThis.__FIXTURE_SHAPE_FINDINGS ?? new Map())].sort(
	(left, right) => right[1] - left[1]
);
const unexplained = runtimeFindings.filter(([key]) => !KNOWN_ABSENT.has(key));
const explained = runtimeFindings.filter(([key]) => KNOWN_ABSENT.has(key));
const surplus = surplusFields(fs.readFileSync(targetPath, 'utf8'));

// ── Report ──────────────────────────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────────────────────────────');
console.log('Fixture-shape audit of scripts/verify-payroll-arithmetic.mjs');
console.log('────────────────────────────────────────────────────────────────\n');

if (!targetCompleted) {
	console.error('The target script did not run to completion, so this audit is INCOMPLETE.');
	console.error(`  ${targetFailure?.message ?? targetFailure}\n`);
} else {
	console.log(
		`Target ran to completion; it reported ${targetAssertionsFailed ? 'at least one FAILED assertion' : 'no failed assertions'}.`
	);
	console.log(
		'If that differs from a plain `node scripts/verify-payroll-arithmetic.mjs` run, the\n' +
			'instrumentation perturbed behaviour and these findings are unreliable.\n'
	);
}

console.log('A — fields the engine read that the fixture does not supply');
if (unexplained.length === 0) {
	console.log('  No unexplained absent fields.');
} else {
	for (const [key, count] of unexplained) console.log(`  ✗ ${key}  (read ${count}×)`);
}
console.log(
	`\n  ${explained.length} further absent-field read${explained.length === 1 ? '' : 's'} ` +
		'suppressed by the KNOWN_ABSENT baseline.'
);
console.log('  This detector CANNOT distinguish an optional `?.` read from a missing required');
console.log('  field. That baseline is hand-curated judgement, not detection — a clean result');
console.log('  here is only as good as those entries. See the header for the full limits.\n');

console.log('B — fixture keys that exist nowhere in src/');
if (surplus.size === 0) {
	console.log('  No surplus fields.');
} else {
	for (const [key, lineNumbers] of surplus) {
		console.log(
			`  ✗ ${key}  (line${lineNumbers.length === 1 ? '' : 's'} ${lineNumbers.join(', ')})`
		);
	}
}
console.log(
	'\n  This detector only asks whether the name occurs in src/ at all, so it under-reports:\n' +
		'  a wrong-but-real field name passes. Local label names used on both sides of an\n' +
		'  assertion are expected here and belong in NOT_ENGINE_FIELDS with a reason.\n'
);

const findings = unexplained.length + surplus.size;
if (!targetCompleted) {
	console.error('FAILED: audit incomplete.\n');
	process.exitCode = 1;
} else if (findings > 0) {
	console.error(`FAILED: ${findings} fixture-shape finding${findings === 1 ? '' : 's'}.\n`);
	process.exitCode = 1;
} else {
	console.log('No fixture-shape findings, within the limits stated above.\n');
}
