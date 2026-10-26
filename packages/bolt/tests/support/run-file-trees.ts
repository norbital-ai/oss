// Skill folders for file runs (P24's table): a CommonJS report with siblings and a vendored dayjs-like package, an ES
// module with top-level await and an ES-module-only package, and what an author gets wrong.
import { Effect } from 'effect';
import { treeDigest } from '../../src/engine/artifact/read.ts';
import type { Skill } from '../../src/engine/agent/tools.ts';
import { Port } from '../../src/engine/port.ts';

const lines = (...text: readonly string[]) => `${text.join('\n')}\n`;
export type Tree = { readonly [path: string]: string };

export const REPORT: Tree = {
	'SKILL.md': lines(
		'---',
		'description: Monthly sales report',
		'---',
		'## Run',
		'run_js { file: "report/scripts/report.js", args: ["/in/sales.csv", "/out/summary.json"] }'
	),
	'scripts/report.js': lines(
		"const fs = require('fs');",
		"const path = require('path');",
		"const { summarize } = require('./lib/summarize');",
		"const dayjs = require('dayjs');",
		'const [input, out] = process.argv.slice(2);',
		"const rows = fs.readFileSync(input, 'utf8').trim().split('\\n').slice(1).map((line) => line.split(','));",
		'const summary = summarize(rows);',
		"summary.month = dayjs('2026-10-01').format('MMMM YYYY');",
		"summary.digest = Buffer.from(JSON.stringify(summary.totals)).toString('base64');",
		'fs.mkdirSync(path.dirname(out), { recursive: true });',
		'fs.writeFileSync(out, JSON.stringify(summary));',
		"console.log('wrote ' + path.basename(out) + ': ' + summary.count + ' rows');"
	),
	'scripts/lib/summarize.js': lines(
		"const { round } = require('../../shared');",
		'module.exports.summarize = (rows) => {',
		'  const totals = {};',
		'  for (const [region, amount] of rows) totals[region] = round((totals[region] ?? 0) + Number(amount));',
		'  return { count: rows.length, totals };',
		'};'
	),
	'shared/index.js': lines('exports.round = (x) => Math.round(x * 100) / 100;'),
	// a vendored package as npm lays it out: its own package.json naming its main file
	'node_modules/dayjs/package.json': lines(
		'{ "name": "dayjs", "version": "1.11.0", "main": "dayjs.min.js" }'
	),
	'node_modules/dayjs/dayjs.min.js': lines(
		"var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];",
		'module.exports = function dayjs(iso) {',
		"  var parts = iso.split('-').map(Number);",
		"  return { format: function () { return MONTHS[parts[1] - 1] + ' ' + parts[0]; } };",
		'};'
	)
};
export const SALES = 'region,amount\nnorth,120.50\nsouth,80.25\nnorth,19.50\neast,42\n';

export const RENDER: Tree = {
	'SKILL.md': lines('---', 'description: Render notes as a page', '---'),
	'scripts/render.mjs': lines(
		"import { readFile, writeFile } from 'node:fs/promises';",
		"import { parse } from 'mdlite';",
		"import { title } from './lib/title.mjs';",
		"import helpers from './lib/helpers.cjs';",
		"const md = await readFile('notes.md', 'utf8');",
		"await writeFile('/out/page.html', helpers.wrap(parse(md)));",
		'console.log(title(md));'
	),
	'scripts/lib/title.mjs': lines('export const title = (md) => md.match(/^# (.+)$/m)[1];'),
	'scripts/lib/helpers.cjs': lines(
		"module.exports = { wrap: (html) => '<main>' + html + '</main>' };"
	),
	'notes.md': lines('# October review', '', 'Sales rose.'),
	// an ES-module-only package: `exports` by condition, no main
	'node_modules/mdlite/package.json': lines(
		'{ "name": "mdlite", "type": "module", "exports": { ".": { "import": "./index.mjs" } } }'
	),
	'node_modules/mdlite/index.mjs': lines(
		"export const parse = (md) => md.trim().split('\\n').filter(Boolean).map((l) => l.startsWith('# ') ? '<h1>' + l.slice(2) + '</h1>' : '<p>' + l + '</p>').join('');"
	)
};

/** What an author gets wrong: each entry fails at bundling, or at run time at its line. */
export const BROKEN: Tree = {
	'SKILL.md': lines('---', 'description: Mistakes', '---'),
	'scripts/broken.mjs': lines("import { parse } from './lib/bad.mjs';", "console.log(parse('x'));"),
	'scripts/lib/bad.mjs': lines(
		'export function parse(text) {',
		'  const words = text.split(" ");',
		'  return words.map((w) => w.length +);',
		'}'
	),
	'scripts/missing.mjs': lines(
		"import { title } from './lib/title.mjs';",
		"import { nothing } from './lib/nowhere.mjs';",
		'console.log(title, nothing);'
	),
	'scripts/lib/title.mjs': lines('export const title = (md) => md;'),
	'scripts/no-export.mjs': lines(
		"import { title, subtitle } from './lib/title.mjs';",
		'console.log(title, subtitle);'
	),
	'scripts/escape.mjs': lines(
		"import hosts from '../../../../../etc/hosts';",
		'console.log(hosts);'
	),
	'scripts/spawn.mjs': lines(
		"import { execSync } from 'node:child_process';",
		"console.log(execSync('id'));"
	),
	'scripts/throws.js': lines(
		"const { explode } = require('./lib/explode');",
		"explode({ code: 'E1' });"
	),
	'scripts/lib/explode.js': lines(
		'exports.explode = (ctx) => {',
		"  const label = 'stage ' + ctx.code;",
		'  if (label) {',
		"    throw new Error('failed at ' + label);",
		'  }',
		'};'
	),
	'scripts/os.js': lines("const os = require('os');", 'console.log(os.platform());'),
	'scripts/exit.js': lines("console.log('leaving');", 'process.exit(3);')
};

const encoder = new TextEncoder();
/** A tree as the bundler takes it: every file by its path. */
export const filesOf = (tree: Tree): (readonly [string, Uint8Array])[] =>
	Object.entries(tree).map(([path, text]): readonly [string, Uint8Array] => [
		path,
		encoder.encode(text)
	]);
/** A tree as the agent holds a skill: its listing, digest and each file's bytes. */
export const skillOf = (tree: Tree): Skill => {
	const files = new Map(filesOf(tree));
	return {
		text: tree['SKILL.md'] ?? '',
		digest: treeDigest(files),
		files: [...files.keys()].sort(),
		read: (path) => {
			const bytes = files.get(path);
			return bytes === undefined
				? Port.unavailable('skill', `no file ${path}`)
				: Effect.succeed(bytes);
		}
	};
};
