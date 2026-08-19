/**
 * The Command panel's tenant-matrix model, and the deterministic layout that draws it.
 *
 * The tenant reads as one lane: the environments the gateway routes to it. The facilities every
 * environment shares are deliberately not drawn — every box hangs off the same set, so a lane of
 * "Database, AI, Communication…" labels repeats one fact per environment instead of saying it once,
 * and the Studio toolbar already names the ones that are missing.
 *
 * Both the shaping and the geometry are pure, so the panel can be asserted without rendering,
 * "what is live" has one definition rather than one per caller, and the graph never reorders
 * between refreshes — a matrix that shuffles on a poll is unreadable.
 *
 * The geometry is hand-computed rather than delegated to a graph library because Colony has no
 * flow-graph dependency, and the shape here is a single fixed lane rather than an arbitrary digraph.
 */

import { humanize } from '@norbital-ai/std/string';
import type { Edge, Node } from '@xyflow/svelte';

export type MatrixEntry = Readonly<{
	readonly tenantId: string;
	readonly environmentId: string;
	readonly releaseId: string;
	readonly artifactId: string;
	readonly health: string;
	readonly ownerEpoch: string;
}>;

export type FacilityState = Readonly<{ readonly name: string; readonly available: boolean }>;

export type TenantMatrixEnvironment = Readonly<{
	readonly id: string;
	readonly label: string;
	readonly releaseId: string;
	readonly artifactId: string;
	readonly health: string;
	readonly ownerEpoch: string;
	readonly live: boolean;
}>;

export type TenantMatrixGraph = Readonly<{
	readonly environments: ReadonlyArray<TenantMatrixEnvironment>;
	readonly live: TenantMatrixEnvironment | undefined;
}>;

const LIVE = 'live';

/** Shapes the routed environments into one readable tenant picture. */
export const buildTenantMatrix = (
	entries: ReadonlyArray<MatrixEntry>,
	_facilities: ReadonlyArray<FacilityState>
): TenantMatrixGraph => {
	const environments = [...entries]
		.map((entry) => ({
			id: entry.environmentId,
			// The lane already says these are environments; only Live is worth naming as one, because
			// it is the box a reader is looking for.
			label: entry.environmentId === LIVE ? 'Live environment' : humanize(entry.environmentId),
			releaseId: entry.releaseId,
			artifactId: entry.artifactId,
			health: entry.health,
			ownerEpoch: entry.ownerEpoch,
			live: entry.environmentId === LIVE
		}))
		.sort((left, right) => {
			if (left.live !== right.live) return left.live ? -1 : 1;
			return left.label.localeCompare(right.label);
		});
	return {
		environments,
		live: environments.find((environment) => environment.live)
	};
};

/** One line inside a drawn node: what it is on the left, what the host said on the right. */
export type MatrixRow = Readonly<{
	readonly label: string;
	readonly value: string;
	/** Full identifier when `value` is a shortened display form. */
	readonly title?: string;
}>;

export type MatrixNode = Readonly<{
	readonly id: string;
	readonly title: string;
	/** Drives the node's chip: what this box is currently doing, in one word. */
	readonly status: string;
	readonly healthy: boolean;
	readonly rows: ReadonlyArray<MatrixRow>;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}>;

export type MatrixLayout = Readonly<{
	readonly nodes: ReadonlyArray<MatrixNode>;
	readonly width: number;
	readonly height: number;
}>;

const NODE_WIDTH = 260;
const NODE_GAP = 24;
const LANE_PAD = 20;
const LANE_HEADER = 26;
const ROW_HEIGHT = 16;
const NODE_HEADER = 34;
/** Vertical room for Bound `pad="sm"` (`p-2` on both ends) plus the card's own gap. */
const NODE_PAD = 20;
const RELEASE_ID_VISIBLE = 16;

/** A node is as tall as its rows need. */
const nodeHeight = (rows: number): number => NODE_HEADER + rows * ROW_HEIGHT + NODE_PAD;

/**
 * Places the environment boxes on a fixed grid, under the lane's own title.
 *
 * `detail` carries the one thing the host reports about a tenant rather than about one route — the
 * authored source revision — so every box can state it without the layout reaching for a snapshot
 * of its own.
 */
export const layoutTenantMatrix = (
	matrix: TenantMatrixGraph,
	detail: { readonly revision: number }
): MatrixLayout => {
	const environmentHeight = nodeHeight(4);
	const environmentsY = LANE_HEADER;

	const environmentNodes = matrix.environments.map((environment, index): MatrixNode => {
		const releaseId = environment.releaseId;
		const releaseValue =
			releaseId === ''
				? 'none'
				: releaseId.length <= RELEASE_ID_VISIBLE
					? releaseId
					: `${releaseId.slice(0, 8)}…${releaseId.slice(-6)}`;
		return {
			id: `environment:${environment.id}`,
			title: environment.label,
			status: environment.live ? 'live' : 'routed',
			healthy: environment.health === 'ready',
			rows: [
				{ label: 'Revision', value: String(detail.revision) },
				{
					label: 'Release',
					value: releaseValue,
					// Stated conditionally rather than as `string | undefined`: with
					// `exactOptionalPropertyTypes` an explicit `undefined` is not an absent key.
					...(releaseId.length > RELEASE_ID_VISIBLE ? { title: releaseId } : {})
				},
				{
					label: 'Artifact',
					value: environment.artifactId === '' ? 'none' : environment.artifactId
				},
				{ label: 'Owner', value: environment.ownerEpoch }
			],
			x: LANE_PAD + index * (NODE_WIDTH + NODE_GAP),
			y: environmentsY + LANE_PAD,
			width: NODE_WIDTH,
			height: environmentHeight
		};
	});

	const widest = environmentNodes.reduce(
		(width, node) => Math.max(width, node.x + node.width),
		NODE_WIDTH
	);
	return {
		nodes: environmentNodes,
		width: widest + LANE_PAD,
		height: environmentsY + LANE_PAD * 2 + environmentHeight + LANE_PAD
	};
};

export type MatrixNodeKind = 'lane' | 'environment';

/** What one flow node holds: the lane is a container, every other node is a routed environment. */
export type MatrixNodeData = Readonly<{
	readonly kind: MatrixNodeKind;
	readonly title: string;
	readonly status: string;
	readonly healthy: boolean;
	readonly rows: ReadonlyArray<MatrixRow>;
}>;

export type MatrixFlowNode = Node<MatrixNodeData, MatrixNodeKind>;
export type MatrixFlowEdge = Edge;

/**
 * Turns the pure layout into a Svelte Flow graph.
 *
 * One dashed lane carries the environment boxes; no edges are drawn, because every environment
 * hangs off the same shared facilities and there is nothing between them to connect. The lane node
 * wears the canvas size so `fitView` frames the boxes, and every node is read-only — this is a
 * picture of the tenant, not a surface to rearrange.
 */
export const buildMatrixFlow = (
	matrix: TenantMatrixGraph,
	detail: { readonly revision: number }
): { nodes: MatrixFlowNode[]; edges: MatrixFlowEdge[] } => {
	const layout = layoutTenantMatrix(matrix, detail);
	const lane: MatrixFlowNode = {
		id: 'lane:environments',
		type: 'lane',
		position: { x: 0, y: 0 },
		draggable: false,
		selectable: false,
		connectable: false,
		data: { kind: 'lane', title: 'Tenant environments', status: '', healthy: true, rows: [] },
		style: `width: ${layout.width}px; height: ${layout.height}px`
	};
	const nodes: MatrixFlowNode[] = [
		lane,
		...layout.nodes.map((node): MatrixFlowNode => ({
			id: node.id,
			type: 'environment',
			position: { x: node.x, y: node.y },
			width: node.width,
			height: node.height,
			style: `width: ${node.width}px; height: ${node.height}px`,
			draggable: false,
			selectable: false,
			connectable: false,
			data: {
				kind: 'environment',
				title: node.title,
				status: node.status,
				healthy: node.healthy,
				rows: node.rows
			}
		}))
	];
	return { nodes, edges: [] };
};
