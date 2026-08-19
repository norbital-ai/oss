import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { boltTask, boltSchedule } from '../../src/runtime/tasks/tables.js';

const db = drizzle(async () => ({ rows: [] }));
const dialect = new PgDialect();

describe('probe', () => {
	it('renders', () => {
		const out: string[] = [];
		const when = sql`select least((select min(${boltTask.runAt}) from ${boltTask} where ${boltTask.status} = 'pending'), (select min(${boltSchedule.nextRunAt}) from ${boltSchedule})) as next_due_at`;
		out.push('WHEN ' + JSON.stringify(dialect.sqlToQuery(when)));
		const prune = db.delete(boltTask).where(
			inArray(
				boltTask.id,
				db
					.select({ id: boltTask.id })
					.from(boltTask)
					.where(
						or(
							and(eq(boltTask.status, 'done'), lte(boltTask.updatedAt, sql`now() - make_interval(days => ${7})`)),
							and(eq(boltTask.status, 'failed'), lte(boltTask.updatedAt, sql`now() - make_interval(days => ${30})`))
						)
					)
					.limit(200)
			)
		);
		out.push('PRUNE ' + JSON.stringify(prune.toSQL()));
		const upsert = db
			.insert(boltSchedule)
			.values({ key: 'k', command: 'c', crontab: '0 6 * * *', input: {}, nextRunAt: new Date(0) })
			.onConflictDoUpdate({
				target: boltSchedule.key,
				set: { command: sql`excluded.command`, crontab: sql`excluded.crontab`, input: sql`excluded.input` }
			});
		out.push('UPSERT ' + JSON.stringify(upsert.toSQL()));
		const dueSchedules = db.select().from(boltSchedule).where(lte(boltSchedule.nextRunAt, sql`now()`));
		out.push('DUE ' + JSON.stringify(dueSchedules.toSQL()));
		const advance = db
			.update(boltSchedule)
			.set({ nextRunAt: new Date(1000), lastFiredAt: sql`now()` })
			.where(eq(boltSchedule.key, 'k'));
		out.push('ADVANCE ' + JSON.stringify(advance.toSQL()));
		const retire = db.delete(boltSchedule).where(sql`${boltSchedule.key} <> all(${['a', 'b']})`);
		out.push('RETIRE ' + JSON.stringify(retire.toSQL()));
		writeFileSync('/tmp/probe-out.txt', out.join('\n'));
	});
});
