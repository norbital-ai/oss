import { defineMessages } from '@norbital-ai/std/i18n';

/**
 * Kanban board surfaces: lane headers, card actions, and board-level empty
 * states.
 *
 * Owned by the kanban migration pass. Keys must stay in the `kanban.*`
 * namespace.
 */
export const kanbanMessages = defineMessages({
	en: {
		'kanban.emptyState': 'No cards yet',
		'kanban.emptyLane': 'No cards in this lane',
		'kanban.addCard': 'Add card',
		'kanban.moveLeft': 'Move left',
		'kanban.moveRight': 'Move right',
		'kanban.cardActions': 'Card actions',
		'kanban.cardCount': '{count} cards',
		'kanban.laneCollapse': 'Collapse lane',
		'kanban.laneExpand': 'Expand lane',
		'kanban.lanesRegion': 'Kanban lanes',
		'kanban.noLaneDirection': 'No lane in that direction. {lane} is the board edge.',
		'kanban.cardMoved': 'Moved card to {lane}.',
		'kanban.moveCancelled': 'Card move cancelled.',
		'kanban.cardPickedUp':
			'Card picked up. Use Left or Right Arrow to move it, or Escape to cancel.',
		'kanban.keyboardInstructions':
			'Press Enter to open a card. Press Space to pick it up, then Left or Right Arrow to move it between lanes. Press Escape to cancel.',
		'kanban.selectCard': 'Select card',
		'kanban.dragCard': 'Drag card',
		'kanban.noLaneJobs': 'No {lane} jobs',
		'kanban.laneClear': 'This lane is clear for the selected view.',
		'kanban.approvalLoading': 'Loading approval payload…',
		'kanban.loadingBoard': 'Loading board',
		'kanban.scrollForMore': 'Scroll for more',
		'kanban.columnRegion': '{column} column',
		'kanban.boardRegion': 'Kanban board'
	},
	zh: {
		'kanban.emptyState': '暂无卡片',
		'kanban.emptyLane': '此列暂无卡片',
		'kanban.addCard': '添加卡片',
		'kanban.moveLeft': '向左移动',
		'kanban.moveRight': '向右移动',
		'kanban.cardActions': '卡片操作',
		'kanban.cardCount': '共 {count} 张卡片',
		'kanban.laneCollapse': '收起此列',
		'kanban.laneExpand': '展开此列',
		'kanban.lanesRegion': '看板列',
		'kanban.noLaneDirection': '该方向没有列。{lane} 是看板的边缘。',
		'kanban.cardMoved': '已将卡片移至{lane}。',
		'kanban.moveCancelled': '已取消卡片移动。',
		'kanban.cardPickedUp': '已拿起卡片。使用左或右方向键移动它，或按 Esc 取消。',
		'kanban.keyboardInstructions':
			'按回车键打开卡片。按空格键拿起卡片，然后用左或右方向键在列间移动，按 Esc 取消。',
		'kanban.selectCard': '选择卡片',
		'kanban.dragCard': '拖动卡片',
		'kanban.noLaneJobs': '没有{lane}任务',
		'kanban.laneClear': '此列在当前视图下没有卡片。',
		'kanban.approvalLoading': '正在加载审批数据…',
		'kanban.loadingBoard': '正在加载看板',
		'kanban.scrollForMore': '向下滚动查看更多',
		'kanban.columnRegion': '{column} 列',
		'kanban.boardRegion': '看板'
	}
});
