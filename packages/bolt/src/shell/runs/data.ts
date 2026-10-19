// Automation run lists use the same caller visibility and redaction as run details.
import { Effect } from 'effect';
import type { Authority } from '../../engine/contracts.ts';
import type { TenantDbShape } from '../../engine/db/tenant-db.ts';
import type { Json } from '../../decl/values.ts';
import { actorRef } from '../../engine/write/commit.ts';
import { RUN_VIEW_COLUMNS, RunViewRow, runView, type RunView } from '../../engine/runs/index.ts';

const q = (text: string, ...params: Json[]) => ({ text, params });

export type RunRow = RunView;
/**
 * The runs list (`bolt.runs`, Settings → Automations): an administrator sees every run; a member (staff or external) the runs of automations they hold and the runs
 * they caused, each as rule 56 lets them read it (status, progress and the error code only for a run they merely caused).
 * `automation` narrows the list to one automation (`bolt.runs`, `RunsFor`).
 */
export const runList = Effect.fn('shell.runList')(function* (
	db: TenantDbShape,
	auth: Authority,
	limit: number = 100,
	automation?: string
) {
	const a = auth.actor;
	if (a.kind !== 'member') return [];
	const rows = yield* db.rows(
		RunViewRow,
		q(
			`SELECT ${RUN_VIEW_COLUMNS} FROM sys_run
		WHERE ($1 OR actor = $2 OR automation IN (SELECT jsonb_array_elements_text($3::jsonb))) AND ($4::text IS NULL OR automation = $4)
		ORDER BY due_at DESC LIMIT ${Math.min(Math.max(1, limit), 500)}`,
			auth.admin,
			actorRef(a),
			JSON.stringify(auth.automations),
			automation ?? null
		)
	);
	return rows.flatMap((row) => runView(auth, row) ?? []);
});
