// The test lint: what a committed test never does. It runs in oss's and Colony's lint step and before `bolt test` in a
// template. A test proves one mechanism, in memory, cheaply: it sets no timeout, never waits on the wall
// clock, spawns or builds nothing, snapshots nothing, reads no source of its own, and connects to no host but loopback.
// The lint step's entry also runs the type-assertion lint (`assertions.ts`) over every module.
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, FileSystem } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { join, relative } from 'node:path';

type Rule = { readonly pattern: RegExp; readonly message: string; readonly template?: true };
const RULES: readonly Rule[] = [
	{
		pattern: /\b(timeout|testTimeout|hookTimeout)\s*:/,
		message: 'a timeout option: heavy is not allowed, never raise a limit'
	},
	{
		// a zero-delay `setTimeout` yields one macrotask and waits on no clock
		pattern:
			/(?<![.\w$])(setInterval|sleep)\s*\(|\bBun\.sleep\s*\(|(?<![.\w$])setTimeout\s*\((?:(?!.*,\s*0\s*[),])(?=.*,)|\s*[1-9][\d_]*)/,
		message: 'a wall-clock wait: use TestClock or wait on the event itself'
	},
	{
		pattern:
			/(from\s+|import\s*\(\s*|require\s*\(\s*)['"](node:)?child_process['"]|(?<![.\w$])(spawn|spawnSync|execSync|execFile|execFileSync)\s*\(|\bBun\.(spawn|spawnSync)\s*\(/,
		message: 'a spawned process'
	},
	{
		pattern:
			/\bbuildWorkspace\s*\(|\bimport\s*\{[^}]*\bbuild\b[^}]*\}\s*from\s*['"](vite|rolldown|esbuild)['"]/,
		message: 'a build inside a test: tests run against the kit checkpoint'
	},
	{
		// the assertion, not a capture: a test may still call a browser's `screenshot()` as the mechanism it proves
		pattern: /\.toMatch(Inline|File)?Snapshot\s*\(|\.toMatchScreenshot\s*\(/,
		message: 'a snapshot or screenshot assertion'
	},
	{
		// a read resolving into the package's own `src/`: a path that starts there (relative to the package or the
		// test), or one anchored on the test's own location; `join(dir, 'src/a.ts')` under a scratch `dir` is data
		pattern:
			/\breadFile\w*\s*\(\s*((new\s+URL|join|resolve)\s*\(\s*)?['"`](\.\.?\/)*src(\/|['"`])|\breadFile\w*\s*\((?=[^;]*(import\.meta\.(url|dirname|filename)|__dirname|process\.cwd\(\)))(?=[^;]*['"`](\.\.?\/)*src(\/|['"`]))/,
		message: 'a read of source: lint the rule instead'
	},
	{
		pattern: /(from\s+|import\s*\(\s*)['"][^'"]+\.svelte['"]/,
		message: 'a Svelte component in a template test: the ui package tests its components',
		template: true
	},
	{
		// a call that opens a connection; a URL as data (a fake's expected request, a manifest field) reaches nothing
		pattern:
			/(?<![.\w$])(fetch|new\s+WebSocket|new\s+EventSource)\s*\(\s*['"`](https?|wss?):\/\/(?!(localhost|127\.0\.0\.1|\[::1\]|[\w.-]*\.(localhost|test|invalid|example)|(www\.)?example\.(com|org|net))([:/?#'"`$]|$))/,
		message: 'a non-loopback host'
	}
];
const TEST = /(^|\/)tests\/|\.(test|spec)\.[cm]?[jt]s$/;
const SOURCE = /\.[cm]?[jt]s$/;
/** The folders no lint reads: dependencies, builds, fixtures, and every dot folder (generated output, data, `.git`). */
const SKIP: ReadonlySet<string> = new Set(['node_modules', 'build', 'dist', 'fixtures']);
const skipped = (name: string) => SKIP.has(name) || /^\.[^.]/.test(name);
const TYPED = /\.([cm]?ts|svelte)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
/** Whether the type-assertion lint reads `path` (relative): a TypeScript module or Svelte component no lint skips, never a declaration. */
export const asserted = (path: string) =>
	TYPED.test(path) && !DECLARATION.test(path) && !path.split(/[\\/]/).some(skipped);
/** A committed snapshot or screenshot directory: what a snapshot assertion compares against. */
const SNAPSHOTS = new Set(['__snapshots__', '__screenshots__']);

/** A string that quotes code (an expected error, a guest's source) is data: the line is read without it. */
const QUOTED_CODE = /"[^"\n]*'[^"\n]*"|'[^'\n]*"[^'\n]*'|`[^`\n]*['"][^`\n]*`/g;

/** One file's violations, as `path:line message`. */
export const lintTest = (
	path: string,
	text: string,
	options: { readonly template?: boolean } = {}
): readonly string[] =>
	text.split('\n').flatMap((line, index) => {
		const code = line.replace(QUOTED_CODE, '""');
		return RULES.filter(
			(rule) => (rule.template !== true || options.template === true) && rule.pattern.test(code)
		).map((rule) => `${path}:${index + 1} ${rule.message}`);
	});

/** Every file under `root` no lint skips, by path relative to `root`, and each committed snapshot directory. */
const tree = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files: string[] = [],
			snapshots: string[] = [];
		const walk = (at: string): Effect.Effect<void, PlatformError> =>
			Effect.gen(function* () {
				for (const name of (yield* fs.readDirectory(at)).toSorted()) {
					if (skipped(name)) continue;
					const path = join(at, name),
						info = yield* fs.stat(path);
					if (info.type === 'Directory' && SNAPSHOTS.has(name)) snapshots.push(relative(root, path));
					else if (info.type === 'Directory') yield* walk(path);
					else if (info.type === 'File') files.push(relative(root, path));
				}
			});
		yield* walk(root);
		return { files, snapshots };
	});

/**
 * Every violation under `root`, paths relative to `root`: the test lint's over its `tests/` folders and `*.test.*`
 * files and, with `assertions`, the type-assertion lint's over every TypeScript module and Svelte component.
 */
export const lintTree = (
	root: string,
	options: { readonly template?: boolean; readonly assertions?: boolean } = {}
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		// the assertion rule loads TypeScript's parser: only a run that asks for it pays for it
		const typed = options.assertions === true ? yield* Effect.promise(() => import('./assertions.ts')) : undefined;
		const { files, snapshots } = yield* tree(root);
		const found = snapshots.map((shown) => `${shown} a committed snapshot or screenshot directory`);
		for (const shown of files) {
			const test = SOURCE.test(shown) && TEST.test(shown),
				assert = typed !== undefined && asserted(shown);
			if (!test && !assert) continue;
			const text = yield* fs.readFileString(join(root, shown));
			if (test) found.push(...lintTest(shown, text, options));
			if (assert)
				found.push(
					...typed.lintAssertions(shown, text).map(({ line, message }) => `${shown}:${line} ${message}`)
				);
		}
		return found;
	});

// `node lint.(ts|js) <dir>...`: the lint step's entry, both lints
if (import.meta.main) {
	const found = await Effect.runPromise(
		Effect.forEach(process.argv.slice(2), (dir) => lintTree(dir, { assertions: true })).pipe(
			Effect.map((all) => all.flat()),
			Effect.provide(NodeFileSystem.layer)
		)
	);
	process.stderr.write(found.map((line) => `${line}\n`).join(''));
	if (found.length > 0) process.exitCode = 1;
}
