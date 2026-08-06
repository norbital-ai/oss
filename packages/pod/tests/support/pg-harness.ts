import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

export type PgHarness = {
	readonly connectionString: string;
	stop(): void;
};

const IMAGE = 'postgres:18-alpine';
/** Marks every container this harness creates, so strays can be found and reaped. */
const LABEL = 'norbital-pg-harness';
/** Records the owning process, so a reaper can tell a live run from an abandoned one. */
const OWNER_LABEL = 'norbital-pg-owner';

/** Fail collection immediately when a real-Postgres suite cannot reach Docker. */
export function requireDocker(): void {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore' });
	} catch (cause) {
		throw new Error(
			'Docker is required for Pod integration tests; refusing to report a green run with the real-Postgres suites skipped.',
			{ cause }
		);
	}
}

function ensurePostgresImage(): void {
	try {
		execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
		return;
	} catch {
		execFileSync('docker', ['pull', IMAGE], { stdio: 'inherit' });
	}
}

function removeContainer(containerId: string): void {
	// `-v` is load-bearing: the postgres image declares its data directory as a VOLUME, so every
	// container creates an anonymous volume. Removing the container without it leaks that volume
	// forever — a few hundred megabytes per test run, which is what filled the Docker disk.
	execFileSync('docker', ['rm', '-f', '-v', containerId], { stdio: 'ignore' });
}

/**
 * Remove harness containers whose owning process is gone. A run that was killed (Ctrl-C, a crashed
 * worker, an OOM) never reaches its own teardown, so without this the strays accumulate silently.
 * Containers belonging to a *live* process are left alone, so concurrent runs are safe.
 */
function reapAbandonedContainers(): void {
	try {
		// `docker ps` supports `label=` but not `label!=`, so filter by owner PID below instead.
		const listed = execFileSync('docker', ['ps', '-aq', '--filter', `label=${LABEL}`], {
			encoding: 'utf8'
		})
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		if (listed.length === 0) return;

		const owners = execFileSync(
			'docker',
			['inspect', '--format', `{{.Id}} {{index .Config.Labels "${OWNER_LABEL}"}}`, ...listed],
			{ encoding: 'utf8' }
		);
		for (const line of owners.split('\n')) {
			const [id, owner] = line.trim().split(' ');
			if (!id || !owner) continue;
			const pid = Number(owner);
			// Leave anything a live process still owns — including this run's own containers, and
			// any concurrent vitest invocation.
			if (!Number.isFinite(pid) || processAlive(pid)) continue;
			removeContainer(id);
		}
	} catch {
		// Reaping is best-effort housekeeping; never fail a test run over it.
	}
}

function processAlive(pid: number): boolean {
	try {
		// Signal 0 checks for existence without delivering anything.
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function hostPort(containerId: string): number {
	const raw = execFileSync('docker', ['port', containerId, '5432/tcp'], {
		encoding: 'utf8'
	});
	// e.g. "0.0.0.0:54321\n[::]:54321\n" — take the first mapping's port.
	for (const line of raw.split('\n')) {
		const match = line.trim().match(/:(\d+)$/);
		if (match) return Number(match[1]);
	}
	throw new Error(`Could not parse mapped port from: ${raw}`);
}

async function waitForReady(connectionString: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const client = new Client({ connectionString });
		try {
			await client.connect();
			await client.query('SELECT 1');
			await client.end();
			return;
		} catch (err) {
			lastError = err;
			await client.end().catch(() => {});
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	throw new Error(`Postgres never became ready: ${String(lastError)}`);
}

/** Containers this process owns and has not torn down yet, for the exit-time safety net. */
const live = new Set<string>();
let exitHookInstalled = false;

/**
 * Last-resort teardown. `afterAll` does not run when the process is killed or throws its way out,
 * and a leaked container holds both a port and a data volume until someone notices by hand.
 */
function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	const cleanup = () => {
		for (const containerId of live) {
			try {
				removeContainer(containerId);
			} catch {
				// nothing useful to do while exiting
			}
		}
		live.clear();
	};
	process.once('exit', cleanup);
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.once(signal, () => {
			cleanup();
			process.exit(130);
		});
	}
}

/**
 * The container this worker process owns, booted at most once.
 *
 * A suite needs its own *schema*, not its own machine, and a database gives it that. Booting a
 * container per suite cost about six seconds each and there are more than twenty suites, which was
 * the largest single item in the run — so the container is now per worker process and each suite
 * gets a fresh database inside it. Isolation is unchanged: two databases share no tables, no
 * sequences and no search path, and Vitest gives each worker its own module registry, so this is
 * one container per worker rather than one shared by all of them.
 */
let ownedContainer: { readonly id: string; readonly port: number } | null = null;
let databaseCounter = 0;

function bootContainer(): { readonly id: string; readonly port: number } {
	const id = execFileSync(
		'docker',
		[
			'run',
			'-d',
			'-P',
			'--label',
			LABEL,
			'--label',
			`${OWNER_LABEL}=${process.pid}`,
			'-e',
			'POSTGRES_PASSWORD=postgres',
			'-e',
			'POSTGRES_DB=postgres',
			IMAGE
		],
		{ encoding: 'utf8' }
	).trim();
	live.add(id);
	return { id, port: hostPort(id) };
}

function connectionStringFor(port: number, database: string): string {
	return `postgresql://postgres:postgres@127.0.0.1:${port}/${database}`;
}

/** Run one statement as the superuser against the maintenance database. */
async function withAdmin<T>(port: number, run: (admin: Client) => Promise<T>): Promise<T> {
	const admin = new Client({ connectionString: connectionStringFor(port, 'postgres') });
	await admin.connect();
	try {
		return await run(admin);
	} finally {
		await admin.end().catch(() => {});
	}
}

let containerPromise: Promise<{ readonly id: string; readonly port: number }> | null = null;

/** The one container this worker owns, booted on first use. */
function ensureContainer(): Promise<{ readonly id: string; readonly port: number }> {
	installExitHook();
	if (containerPromise) return containerPromise;
	containerPromise = (async () => {
		reapAbandonedContainers();
		ensurePostgresImage();
		const container = bootContainer();
		try {
			await waitForReady(connectionStringFor(container.port, 'postgres'));
		} catch (err) {
			live.delete(container.id);
			removeContainer(container.id);
			containerPromise = null;
			throw err;
		}
		ownedContainer = container;
		return container;
	})();
	return containerPromise;
}

/** Boot (or reuse) a Postgres 18 container and return a fresh empty database on it. */
export async function startPostgres(): Promise<PgHarness> {
	const container = await ensureContainer();
	const database = `poddb_${process.pid}_${++databaseCounter}`;
	await withAdmin(container.port, (admin) => admin.query(`CREATE DATABASE "${database}"`));
	return {
		connectionString: connectionStringFor(container.port, database),
		stop() {
			// Best effort, and deliberately not awaited: the suite's own pools may still be closing,
			// which makes DROP DATABASE fail with "being accessed by other users". Nothing leaks
			// either way — the container and every database in it go at process exit.
			void dropDatabase(container.port, database);
		}
	};
}

/** Template databases this worker has already prepared, keyed by the caller's cache key. */
const preparedTemplates = new Map<string, Promise<string>>();

/**
 * A fresh database cloned from one this worker prepared once.
 *
 * `prepare` is the expensive part — for the runtime harness it is a `pod migrate`, a whole Node
 * process that builds and applies the schema — and it produced an identical database for every
 * suite asking for the same template. Postgres can copy a database it has already got:
 * `CREATE DATABASE … TEMPLATE …` is a file copy, so the twenty-second suite pays that instead of
 * another migration.
 *
 * `prepare` runs at most once per key per worker, and its connections must be closed when it
 * returns — Postgres refuses to clone a database anything else is connected to. A `pod migrate`
 * subprocess satisfies that by exiting.
 */
export async function startPostgresFromTemplate(
	key: string,
	prepare: (connectionString: string) => Promise<void> | void
): Promise<PgHarness> {
	const container = await ensureContainer();
	let templatePromise = preparedTemplates.get(key);
	if (!templatePromise) {
		templatePromise = (async () => {
			const name = `podtpl_${process.pid}_${preparedTemplates.size}`;
			await withAdmin(container.port, (admin) => admin.query(`CREATE DATABASE "${name}"`));
			await prepare(connectionStringFor(container.port, name));
			return name;
		})();
		preparedTemplates.set(key, templatePromise);
	}
	// A failed prepare must not be cached, or every later suite inherits one broken template.
	const templateName = await templatePromise.catch((error: unknown) => {
		preparedTemplates.delete(key);
		throw error;
	});

	const database = `poddb_${process.pid}_${++databaseCounter}`;
	await withAdmin(container.port, (admin) =>
		admin.query(`CREATE DATABASE "${database}" TEMPLATE "${templateName}"`)
	);
	return {
		connectionString: connectionStringFor(container.port, database),
		stop() {
			void dropDatabase(container.port, database);
		}
	};
}

async function dropDatabase(port: number, database: string): Promise<void> {
	const admin = new Client({
		connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`
	});
	try {
		await admin.connect();
		await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
	} catch {
		// See stop(): reclaimed at exit regardless.
	} finally {
		await admin.end().catch(() => {});
	}
}
