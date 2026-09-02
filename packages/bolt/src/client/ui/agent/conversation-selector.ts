import { Option, Schema } from 'effect';
import {
	AgentId,
	PlanId,
	RunId,
	TaskAudience,
	TaskId,
	TaskStatus
} from '@norbital-ai/bolt-protocol';

/** Stable ID of the browser-owned system agent. */
export const WEB_AGENT_ID = 'web';

const AgentTask = Schema.Struct({
	id: TaskId,
	agent_id: AgentId,
	audience: TaskAudience,
	parent_id: Schema.optionalKey(Schema.NullOr(TaskId)),
	status: TaskStatus,
	active_plan_id: Schema.optionalKey(Schema.NullOr(PlanId)),
	active_run_id: Schema.optionalKey(Schema.NullOr(RunId))
});
export type AgentTask = Readonly<{
	id: typeof TaskId.Type;
	agent_id: typeof AgentId.Type;
	audience: typeof TaskAudience.Type;
	parent_id: typeof TaskId.Type | null;
	status: typeof TaskStatus.Type;
	active_plan_id: typeof PlanId.Type | null;
	active_run_id: typeof RunId.Type | null;
}>;

const decodeAgentTask = Schema.decodeUnknownOption(AgentTask);

/** Rejects rows that do not satisfy the one canonical durable Task shape. */
export function projectAgentTasks(rows: readonly unknown[]): AgentTask[] {
	return rows.flatMap((row) => {
		const decoded = decodeAgentTask(row);
		if (Option.isNone(decoded)) return [];
		const task = decoded.value;
		return [
			{
				id: task.id,
				agent_id: task.agent_id,
				audience: task.audience,
				parent_id: task.parent_id ?? null,
				status: task.status,
				active_plan_id: task.active_plan_id ?? null,
				active_run_id: task.active_run_id ?? null
			}
		];
	});
}

type TaskSelectorLabels = Readonly<{
	personal: string;
	workbench: string;
}>;

type TaskSelectorAgent = Readonly<{
	id: string;
	label: string;
	icon: string;
}>;

type TaskSelectorHeading = Readonly<{
	kind: 'heading';
	id: string;
	label: string;
}>;

type TaskSelectorTask = Readonly<{
	kind: 'task';
	id: string;
	title: string;
	icon: string;
	searchText: string;
	audience: 'personal' | 'workbench';
}>;

type TaskSelectorRow = TaskSelectorHeading | TaskSelectorTask;

export type TaskSelectorModel = Readonly<{
	agents: readonly TaskSelectorAgent[];
	rowsByAgent: Readonly<Record<string, readonly TaskSelectorRow[]>>;
}>;

/** Groups policy-filtered root Tasks by canonical agent and audience. */
export function buildTaskSelector(input: {
	readonly tasks: readonly AgentTask[];
	readonly labels: TaskSelectorLabels;
}): TaskSelectorModel {
	const byAgent = new Map<string, AgentTask[]>();
	for (const task of input.tasks) {
		byAgent.set(task.agent_id, [...(byAgent.get(task.agent_id) ?? []), task]);
	}

	const agents = [...byAgent.keys()]
		.map((id) => ({
			id,
			label: id === WEB_AGENT_ID ? 'Web' : id,
			icon: id === WEB_AGENT_ID ? 'lucide:monitor' : 'lucide:bot'
		}))
		.sort((left, right) => {
			if (left.id === WEB_AGENT_ID) return -1;
			if (right.id === WEB_AGENT_ID) return 1;
			return left.label.localeCompare(right.label);
		});

	const rowsByAgent: Record<string, TaskSelectorRow[]> = {};
	for (const agent of agents) {
		const tasks = byAgent.get(agent.id) ?? [];
		const personal = tasks.filter((task) => task.audience === 'personal');
		const workbench = tasks.filter((task) => task.audience === 'workbench');
		const showHeadings = personal.length > 0 && workbench.length > 0;
		const rows: TaskSelectorRow[] = [];
		if (showHeadings) {
			rows.push({
				kind: 'heading',
				id: `heading:${agent.id}:personal`,
				label: input.labels.personal
			});
		}
		for (const task of personal) {
			rows.push({
				kind: 'task',
				id: task.id,
				title: `${task.status} · ${task.id.slice(0, 8)}`,
				icon: task.status === 'failed' ? 'lucide:circle-alert' : 'lucide:message-square',
				searchText: `${task.id} ${task.status} ${task.agent_id}`,
				audience: 'personal'
			});
		}
		if (showHeadings) {
			rows.push({
				kind: 'heading',
				id: `heading:${agent.id}:workbench`,
				label: input.labels.workbench
			});
		}
		for (const task of workbench) {
			rows.push({
				kind: 'task',
				id: task.id,
				title: `${task.status} · ${task.id.slice(0, 8)}`,
				icon: task.status === 'failed' ? 'lucide:circle-alert' : 'lucide:message-square',
				searchText: `${task.id} ${task.status} ${task.agent_id}`,
				audience: 'workbench'
			});
		}
		rowsByAgent[agent.id] = rows;
	}

	return { agents, rowsByAgent };
}
