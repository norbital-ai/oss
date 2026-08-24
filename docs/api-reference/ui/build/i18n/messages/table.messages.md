[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/i18n/messages/table.messages

# ui/build/i18n/messages/table.messages

## Variables

<a id="tablemessages"></a>

### tableMessages

```ts
const tableMessages: object;
```

Defined in: packages/ui/build/i18n/messages/table.messages.d.ts:8

Collection table surfaces: grids, pagination chrome, sorting, selection
actions, and empty states.

Owned by the collection-table migration pass. Keys must stay in the
`table.*` namespace and must not collide with other namespaces.

#### Type Declaration

<a id="en"></a>

##### en

```ts
readonly en: object;
```

###### en.table.aboutCollection

```ts
readonly table.aboutCollection: "About this collection";
```

###### en.table.actionRefreshFailed

```ts
readonly table.actionRefreshFailed: "Action completed, but the table did not refresh";
```

###### en.table.all

```ts
readonly table.all: "All";
```

###### en.table.applicationLock

```ts
readonly table.applicationLock: "Application";
```

###### en.table.appliedByView

```ts
readonly table.appliedByView: "Applied by this view";
```

###### en.table.appliedFilters

```ts
readonly table.appliedFilters: "Applied filters";
```

###### en.table.approvalActionFailed

```ts
readonly table.approvalActionFailed: "Approval action failed";
```

###### en.table.approvalApproved

```ts
readonly table.approvalApproved: "Request approved";
```

###### en.table.approvalAwaiting

```ts
readonly table.approvalAwaiting: "This record is awaiting approval.";
```

###### en.table.approvalChangesRequested

```ts
readonly table.approvalChangesRequested: "Changes requested";
```

###### en.table.approvalLoading

```ts
readonly table.approvalLoading: "Loading approval status…";
```

###### en.table.approvalRegion

```ts
readonly table.approvalRegion: "{title} approval";
```

###### en.table.approvalRejected

```ts
readonly table.approvalRejected: "Request rejected";
```

###### en.table.approvalRequest

```ts
readonly table.approvalRequest: "Approval request";
```

###### en.table.approvalRequestId

```ts
readonly table.approvalRequestId: "Request ID";
```

###### en.table.approvalStatus

```ts
readonly table.approvalStatus: "Status: {status}";
```

###### en.table.approvalSuperseded

```ts
readonly table.approvalSuperseded: "Approval superseded";
```

###### en.table.approvalWithdrawFailed

```ts
readonly table.approvalWithdrawFailed: "Unable to withdraw approval request";
```

###### en.table.approvalWithdrawn

```ts
readonly table.approvalWithdrawn: "Approval request withdrawn";
```

###### en.table.approve

```ts
readonly table.approve: "Approve";
```

###### en.table.bulkDeleted

```ts
readonly table.bulkDeleted: "Deleted {label}";
```

###### en.table.bulkFailed

```ts
readonly table.bulkFailed: "Bulk {kind} failed";
```

###### en.table.bulkStep1

```ts
readonly table.bulkStep1: "1. Choose a field";
```

###### en.table.bulkStep2

```ts
readonly table.bulkStep2: "2. Set the new value";
```

###### en.table.bulkStep3

```ts
readonly table.bulkStep3: "3. Review update";
```

###### en.table.bulkUpdate

```ts
readonly table.bulkUpdate: "Bulk update";
```

###### en.table.bulkUpdated

```ts
readonly table.bulkUpdated: "Updated {label}";
```

###### en.table.changeRequestReason

```ts
readonly table.changeRequestReason: "Change request reason";
```

###### en.table.chooseField

```ts
readonly table.chooseField: "Choose a field";
```

###### en.table.chooseFieldToUpdate

```ts
readonly table.chooseFieldToUpdate: "Choose a field to update";
```

###### en.table.chooseFilterField

```ts
readonly table.chooseFilterField: "Choose a filter field";
```

###### en.table.chooseOperator

```ts
readonly table.chooseOperator: "Choose an operator";
```

###### en.table.clearAll

```ts
readonly table.clearAll: "Clear all";
```

###### en.table.closeRecordDetail

```ts
readonly table.closeRecordDetail: "Close record detail";
```

###### en.table.collapse

```ts
readonly table.collapse: "Collapse";
```

###### en.table.collapseRowDetails

```ts
readonly table.collapseRowDetails: "Collapse row details";
```

###### en.table.collectionActions

```ts
readonly table.collectionActions: "Collection actions";
```

###### en.table.collectionActionsDescription

```ts
readonly table.collectionActionsDescription: "Run configured pipelines or change selected records.";
```

###### en.table.columnActions

```ts
readonly table.columnActions: "Column actions";
```

###### en.table.columns

```ts
readonly table.columns: "Columns";
```

###### en.table.columnToggle

```ts
readonly table.columnToggle: "Toggle column visibility";
```

###### en.table.confirmDeleteDescription

```ts
readonly table.confirmDeleteDescription: "This permanently removes the selected records. Linked records or collection policy may block the deletion.";
```

###### en.table.confirmDeleteTitle

```ts
readonly table.confirmDeleteTitle: "Delete {label}?";
```

###### en.table.confirmUpdate

```ts
readonly table.confirmUpdate: "Confirm update";
```

###### en.table.confirmUpdateDescription

```ts
readonly table.confirmUpdateDescription: "Every selected record will receive the same value for {field}.";
```

###### en.table.confirmUpdateTitle

```ts
readonly table.confirmUpdateTitle: "Update {label}?";
```

###### en.table.createFormDescription

```ts
readonly table.createFormDescription: "{label} form";
```

###### en.table.deleteRecords

```ts
readonly table.deleteRecords: "Delete records";
```

###### en.table.deleteSelectedLabel

```ts
readonly table.deleteSelectedLabel: "Delete {label}.";
```

###### en.table.describeChangesPlaceholder

```ts
readonly table.describeChangesPlaceholder: "Describe the required changes";
```

###### en.table.detailMissingId

```ts
readonly table.detailMissingId: "Cannot open detail without {field}.";
```

###### en.table.detailOpen

```ts
readonly table.detailOpen: "Open record";
```

###### en.table.detailUnavailable

```ts
readonly table.detailUnavailable: "Record detail is unavailable.";
```

###### en.table.display

```ts
readonly table.display: "Display";
```

###### en.table.emptyState

```ts
readonly table.emptyState: "No records yet";
```

###### en.table.emptyStateFiltered

```ts
readonly table.emptyStateFiltered: "No records match the current filters";
```

###### en.table.emptyStateHint

```ts
readonly table.emptyStateHint: "Try adjusting your search or filters";
```

###### en.table.expand

```ts
readonly table.expand: "Expand";
```

###### en.table.expandRowDetails

```ts
readonly table.expandRowDetails: "Expand row details";
```

###### en.table.export

```ts
readonly table.export: "Export";
```

###### en.table.filterActive

```ts
readonly table.filterActive: "Filters active";
```

###### en.table.filterAdd

```ts
readonly table.filterAdd: "Add filter";
```

###### en.table.filterAnd

```ts
readonly table.filterAnd: "And";
```

###### en.table.filterAnyOf

```ts
readonly table.filterAnyOf: "Any of: {values}";
```

###### en.table.filterAtLeast

```ts
readonly table.filterAtLeast: "{label} is at least {value}";
```

###### en.table.filterAtMost

```ts
readonly table.filterAtMost: "{label} is at most {value}";
```

###### en.table.filterContains

```ts
readonly table.filterContains: "{label} contains {value}";
```

###### en.table.filterFields

```ts
readonly table.filterFields: "Filter fields";
```

###### en.table.filterGreaterThan

```ts
readonly table.filterGreaterThan: "{label} is greater than {value}";
```

###### en.table.filterIs

```ts
readonly table.filterIs: "{label} is {value}";
```

###### en.table.filterIsEmpty

```ts
readonly table.filterIsEmpty: "{label} is empty";
```

###### en.table.filterIsNot

```ts
readonly table.filterIsNot: "{label} is not {value}";
```

###### en.table.filterIsNotEmpty

```ts
readonly table.filterIsNotEmpty: "{label} is not empty";
```

###### en.table.filterLessThan

```ts
readonly table.filterLessThan: "{label} is less than {value}";
```

###### en.table.filterNot

```ts
readonly table.filterNot: "Not {label}";
```

###### en.table.filterOr

```ts
readonly table.filterOr: "Or";
```

###### en.table.filterRecords

```ts
readonly table.filterRecords: "Filter records";
```

###### en.table.filterRemove

```ts
readonly table.filterRemove: "Remove filter";
```

###### en.table.filters

```ts
readonly table.filters: "Filters";
```

###### en.table.filtersAllMatch

```ts
readonly table.filtersAllMatch: "All conditions must match.";
```

###### en.table.fitAll

```ts
readonly table.fitAll: "Fit all";
```

###### en.table.fitColumn

```ts
readonly table.fitColumn: "Fit column";
```

###### en.table.format

```ts
readonly table.format: "Format";
```

###### en.table.groupBy

```ts
readonly table.groupBy: "Group by";
```

###### en.table.hideColumn

```ts
readonly table.hideColumn: "Hide column";
```

###### en.table.import

```ts
readonly table.import: "Import";
```

###### en.table.integrations

```ts
readonly table.integrations: "Integrations";
```

###### en.table.linksTo

```ts
readonly table.linksTo: "Links to {target}";
```

###### en.table.loadError

```ts
readonly table.loadError: "Something went wrong";
```

###### en.table.loading

```ts
readonly table.loading: "Loading records…";
```

###### en.table.loadingRecord

```ts
readonly table.loadingRecord: "Loading record…";
```

###### en.table.metadataError

```ts
readonly table.metadataError: "No field metadata is available for {collection}.";
```

###### en.table.nextPage

```ts
readonly table.nextPage: "Next page";
```

###### en.table.noApprovalRequest

```ts
readonly table.noApprovalRequest: "No approval request";
```

###### en.table.noApprovalRequestDesc

```ts
readonly table.noApprovalRequestDesc: "This record has no approval workflow activity yet.";
```

###### en.table.noCustomView

```ts
readonly table.noCustomView: "No custom record view";
```

###### en.table.noCustomViewDesc

```ts
readonly table.noCustomViewDesc: "This collection has no dedicated UI representation. Use Raw to inspect its fields.";
```

###### en.table.noFiltersApplied

```ts
readonly table.noFiltersApplied: "No filters applied.";
```

###### en.table.noIntegrationsConfigured

```ts
readonly table.noIntegrationsConfigured: "No integrations configured";
```

###### en.table.noIntegrationsDescription

```ts
readonly table.noIntegrationsDescription: "This collection is not currently connected to an external integration.";
```

###### en.table.noPipelinesConfigured

```ts
readonly table.noPipelinesConfigured: "No {kind} pipelines configured";
```

###### en.table.noPipelinesDeclared

```ts
readonly table.noPipelinesDeclared: "This collection does not currently declare a {kind} pipeline.";
```

###### en.table.noValueNeeded

```ts
readonly table.noValueNeeded: "No value needed";
```

###### en.table.openCollectionActions

```ts
readonly table.openCollectionActions: "Open collection actions";
```

###### en.table.pageOf

```ts
readonly table.pageOf: "Page {page} of {pages}";
```

###### en.table.pageSizeDisabled

```ts
readonly table.pageSizeDisabled: "Page size is disabled";
```

###### en.table.pendingApproval

```ts
readonly table.pendingApproval: "Pending approval";
```

###### en.table.pendingSync

```ts
readonly table.pendingSync: "Not saved yet — waiting to sync";
```

###### en.table.perPage

```ts
readonly table.perPage: "/ page";
```

###### en.table.pinColumn

```ts
readonly table.pinColumn: "Pin column";
```

###### en.table.pipelineDescription

```ts
readonly table.pipelineDescription: "{label} {kind} pipeline.";
```

###### en.table.pipelineFailed

```ts
readonly table.pipelineFailed: "{label} failed";
```

###### en.table.pipelineSelectRows

```ts
readonly table.pipelineSelectRows: "Select one or more rows to run {label}.";
```

###### en.table.previousPage

```ts
readonly table.previousPage: "Previous page";
```

###### en.table.rawRegion

```ts
readonly table.rawRegion: "{title} raw data";
```

###### en.table.recordDescription

```ts
readonly table.recordDescription: "{name} record";
```

###### en.table.recordDetails

```ts
readonly table.recordDetails: "{name} record details";
```

###### en.table.recordLoadFailed

```ts
readonly table.recordLoadFailed: "Record could not be loaded";
```

###### en.table.recordLocked

```ts
readonly table.recordLocked: "Application lock — this record can no longer be changed";
```

###### en.table.recordsRegion

```ts
readonly table.recordsRegion: "Collection records";
```

###### en.table.recordUnavailable

```ts
readonly table.recordUnavailable: "This record is no longer available.";
```

###### en.table.refresh

```ts
readonly table.refresh: "Refresh data";
```

###### en.table.refreshFailed

```ts
readonly table.refreshFailed: "Refresh failed";
```

###### en.table.reject

```ts
readonly table.reject: "Reject";
```

###### en.table.reorderColumns

```ts
readonly table.reorderColumns: "Reorder columns";
```

###### en.table.requestChanges

```ts
readonly table.requestChanges: "Request changes";
```

###### en.table.requestChangesDescription

```ts
readonly table.requestChangesDescription: "Explain what must change before this request can be approved.";
```

###### en.table.requesting

```ts
readonly table.requesting: "Requesting…";
```

###### en.table.resetWidth

```ts
readonly table.resetWidth: "Reset width";
```

###### en.table.resizeColumn

```ts
readonly table.resizeColumn: "Resize column";
```

###### en.table.reviewDeletion

```ts
readonly table.reviewDeletion: "Review deletion";
```

###### en.table.rowActions

```ts
readonly table.rowActions: "Row actions";
```

###### en.table.rowCount

```ts
readonly table.rowCount: "{count} rows";
```

###### en.table.rowsPerPage

```ts
readonly table.rowsPerPage: "Rows per page";
```

###### en.table.rowsRegion

```ts
readonly table.rowsRegion: "Collection table rows";
```

###### en.table.run

```ts
readonly table.run: "Run";
```

###### en.table.runPipeline

```ts
readonly table.runPipeline: "Run {label}";
```

###### en.table.searchActive

```ts
readonly table.searchActive: "Search active";
```

###### en.table.searchFields

```ts
readonly table.searchFields: "Search fields…";
```

###### en.table.searchFieldsOverflow

```ts
readonly table.searchFieldsOverflow: "{fields} +{count} more";
```

###### en.table.searchIn

```ts
readonly table.searchIn: "Search {fields}…";
```

###### en.table.searchRecords

```ts
readonly table.searchRecords: "Search records";
```

###### en.table.selectAllRows

```ts
readonly table.selectAllRows: "Select all rows";
```

###### en.table.selectedCount

```ts
readonly table.selectedCount: "{count} selected";
```

###### en.table.selectedFraction

```ts
readonly table.selectedFraction: "{selected} / {total} selected";
```

###### en.table.selectedRecord

```ts
readonly table.selectedRecord: "{count} selected record";
```

###### en.table.selectedRecords

```ts
readonly table.selectedRecords: "{count} selected records";
```

###### en.table.selectFieldPlaceholder

```ts
readonly table.selectFieldPlaceholder: "Select a primitive or linked field";
```

###### en.table.selectRecordLabel

```ts
readonly table.selectRecordLabel: "Select {label}";
```

###### en.table.selectRow

```ts
readonly table.selectRow: "Select row";
```

###### en.table.showColumn

```ts
readonly table.showColumn: "Show column";
```

###### en.table.sizing

```ts
readonly table.sizing: "Sizing";
```

###### en.table.sortAscending

```ts
readonly table.sortAscending: "Sort ascending";
```

###### en.table.sortClear

```ts
readonly table.sortClear: "Clear sort";
```

###### en.table.sortClearLabel

```ts
readonly table.sortClearLabel: "Clear sort for {label}";
```

###### en.table.sortDescending

```ts
readonly table.sortDescending: "Sort descending";
```

###### en.table.sortLabelAscending

```ts
readonly table.sortLabelAscending: "Sort {label} ascending";
```

###### en.table.sortLabelDescending

```ts
readonly table.sortLabelDescending: "Sort {label} descending";
```

###### en.table.supersedeApproval

```ts
readonly table.supersedeApproval: "Supersede approval";
```

###### en.table.supersedeApprovalDescription

```ts
readonly table.supersedeApprovalDescription: "Finish every remaining approval stage. This is exceptional and will be recorded in the audit trail.";
```

###### en.table.supersedeReason

```ts
readonly table.supersedeReason: "Reason for superseding";
```

###### en.table.supersedeReasonPlaceholder

```ts
readonly table.supersedeReasonPlaceholder: "Explain why the remaining review is being bypassed";
```

###### en.table.supersedingApproval

```ts
readonly table.supersedingApproval: "Superseding…";
```

###### en.table.systemFields

```ts
readonly table.systemFields: "System fields";
```

###### en.table.systemLock

```ts
readonly table.systemLock: "System";
```

###### en.table.systemLockPendingApproval

```ts
readonly table.systemLockPendingApproval: "System lock — pending approval";
```

###### en.table.tabApproval

```ts
readonly table.tabApproval: "Approval";
```

###### en.table.tabRaw

```ts
readonly table.tabRaw: "Raw";
```

###### en.table.tabUi

```ts
readonly table.tabUi: "UI";
```

###### en.table.toolbarRegion

```ts
readonly table.toolbarRegion: "Collection toolbar";
```

###### en.table.unableToLoadRecords

```ts
readonly table.unableToLoadRecords: "Unable to load records";
```

###### en.table.ungroup

```ts
readonly table.ungroup: "Ungroup";
```

###### en.table.unpinColumn

```ts
readonly table.unpinColumn: "Unpin column";
```

###### en.table.viewDisabled

```ts
readonly table.viewDisabled: "This view is not accepting changes right now.";
```

###### en.table.withdrawRequest

```ts
readonly table.withdrawRequest: "Withdraw request";
```

<a id="zh"></a>

##### zh

```ts
readonly zh: object;
```

###### zh.table.aboutCollection

```ts
readonly table.aboutCollection: "关于此集合";
```

###### zh.table.actionRefreshFailed

```ts
readonly table.actionRefreshFailed: "操作已完成，但表格未刷新";
```

###### zh.table.all

```ts
readonly table.all: "全部";
```

###### zh.table.applicationLock

```ts
readonly table.applicationLock: "应用";
```

###### zh.table.appliedByView

```ts
readonly table.appliedByView: "由当前视图应用";
```

###### zh.table.appliedFilters

```ts
readonly table.appliedFilters: "已应用的筛选";
```

###### zh.table.approvalActionFailed

```ts
readonly table.approvalActionFailed: "审批操作失败";
```

###### zh.table.approvalApproved

```ts
readonly table.approvalApproved: "请求已批准";
```

###### zh.table.approvalAwaiting

```ts
readonly table.approvalAwaiting: "此记录正在等待审批。";
```

###### zh.table.approvalChangesRequested

```ts
readonly table.approvalChangesRequested: "已请求变更";
```

###### zh.table.approvalLoading

```ts
readonly table.approvalLoading: "正在加载审批状态…";
```

###### zh.table.approvalRegion

```ts
readonly table.approvalRegion: "{title} 审批";
```

###### zh.table.approvalRejected

```ts
readonly table.approvalRejected: "请求已驳回";
```

###### zh.table.approvalRequest

```ts
readonly table.approvalRequest: "审批请求";
```

###### zh.table.approvalRequestId

```ts
readonly table.approvalRequestId: "请求 ID";
```

###### zh.table.approvalStatus

```ts
readonly table.approvalStatus: "状态：{status}";
```

###### zh.table.approvalSuperseded

```ts
readonly table.approvalSuperseded: "审批已被越级完成";
```

###### zh.table.approvalWithdrawFailed

```ts
readonly table.approvalWithdrawFailed: "无法撤回审批请求";
```

###### zh.table.approvalWithdrawn

```ts
readonly table.approvalWithdrawn: "审批请求已撤回";
```

###### zh.table.approve

```ts
readonly table.approve: "批准";
```

###### zh.table.bulkDeleted

```ts
readonly table.bulkDeleted: "已删除{label}";
```

###### zh.table.bulkFailed

```ts
readonly table.bulkFailed: "批量{kind}失败";
```

###### zh.table.bulkStep1

```ts
readonly table.bulkStep1: "1. 选择字段";
```

###### zh.table.bulkStep2

```ts
readonly table.bulkStep2: "2. 设置新值";
```

###### zh.table.bulkStep3

```ts
readonly table.bulkStep3: "3. 确认更新";
```

###### zh.table.bulkUpdate

```ts
readonly table.bulkUpdate: "批量更新";
```

###### zh.table.bulkUpdated

```ts
readonly table.bulkUpdated: "已更新{label}";
```

###### zh.table.changeRequestReason

```ts
readonly table.changeRequestReason: "变更请求原因";
```

###### zh.table.chooseField

```ts
readonly table.chooseField: "选择字段";
```

###### zh.table.chooseFieldToUpdate

```ts
readonly table.chooseFieldToUpdate: "选择要更新的字段";
```

###### zh.table.chooseFilterField

```ts
readonly table.chooseFilterField: "选择筛选字段";
```

###### zh.table.chooseOperator

```ts
readonly table.chooseOperator: "选择运算符";
```

###### zh.table.clearAll

```ts
readonly table.clearAll: "全部清除";
```

###### zh.table.closeRecordDetail

```ts
readonly table.closeRecordDetail: "关闭记录详情";
```

###### zh.table.collapse

```ts
readonly table.collapse: "收起";
```

###### zh.table.collapseRowDetails

```ts
readonly table.collapseRowDetails: "收起行详情";
```

###### zh.table.collectionActions

```ts
readonly table.collectionActions: "集合操作";
```

###### zh.table.collectionActionsDescription

```ts
readonly table.collectionActionsDescription: "运行已配置的流程或更改选中的记录。";
```

###### zh.table.columnActions

```ts
readonly table.columnActions: "列操作";
```

###### zh.table.columns

```ts
readonly table.columns: "列";
```

###### zh.table.columnToggle

```ts
readonly table.columnToggle: "切换列显示";
```

###### zh.table.confirmDeleteDescription

```ts
readonly table.confirmDeleteDescription: "这将永久删除选中的记录。关联记录或集合策略可能阻止删除。";
```

###### zh.table.confirmDeleteTitle

```ts
readonly table.confirmDeleteTitle: "删除{label}？";
```

###### zh.table.confirmUpdate

```ts
readonly table.confirmUpdate: "确认更新";
```

###### zh.table.confirmUpdateDescription

```ts
readonly table.confirmUpdateDescription: "所有选中的记录都将应用相同的值：{field}。";
```

###### zh.table.confirmUpdateTitle

```ts
readonly table.confirmUpdateTitle: "更新{label}？";
```

###### zh.table.createFormDescription

```ts
readonly table.createFormDescription: "{label} 表单";
```

###### zh.table.deleteRecords

```ts
readonly table.deleteRecords: "删除记录";
```

###### zh.table.deleteSelectedLabel

```ts
readonly table.deleteSelectedLabel: "删除{label}。";
```

###### zh.table.describeChangesPlaceholder

```ts
readonly table.describeChangesPlaceholder: "描述需要进行的更改";
```

###### zh.table.detailMissingId

```ts
readonly table.detailMissingId: "无法打开详情：缺少 {field}。";
```

###### zh.table.detailOpen

```ts
readonly table.detailOpen: "打开记录";
```

###### zh.table.detailUnavailable

```ts
readonly table.detailUnavailable: "记录详情不可用。";
```

###### zh.table.display

```ts
readonly table.display: "显示";
```

###### zh.table.emptyState

```ts
readonly table.emptyState: "暂无记录";
```

###### zh.table.emptyStateFiltered

```ts
readonly table.emptyStateFiltered: "没有符合当前筛选条件的记录";
```

###### zh.table.emptyStateHint

```ts
readonly table.emptyStateHint: "请调整搜索或筛选条件";
```

###### zh.table.expand

```ts
readonly table.expand: "展开";
```

###### zh.table.expandRowDetails

```ts
readonly table.expandRowDetails: "展开行详情";
```

###### zh.table.export

```ts
readonly table.export: "导出";
```

###### zh.table.filterActive

```ts
readonly table.filterActive: "已应用筛选";
```

###### zh.table.filterAdd

```ts
readonly table.filterAdd: "添加筛选条件";
```

###### zh.table.filterAnd

```ts
readonly table.filterAnd: "并且";
```

###### zh.table.filterAnyOf

```ts
readonly table.filterAnyOf: "任意一项：{values}";
```

###### zh.table.filterAtLeast

```ts
readonly table.filterAtLeast: "{label}不小于{value}";
```

###### zh.table.filterAtMost

```ts
readonly table.filterAtMost: "{label}不大于{value}";
```

###### zh.table.filterContains

```ts
readonly table.filterContains: "{label}包含{value}";
```

###### zh.table.filterFields

```ts
readonly table.filterFields: "筛选字段";
```

###### zh.table.filterGreaterThan

```ts
readonly table.filterGreaterThan: "{label}大于{value}";
```

###### zh.table.filterIs

```ts
readonly table.filterIs: "{label}为{value}";
```

###### zh.table.filterIsEmpty

```ts
readonly table.filterIsEmpty: "{label}为空";
```

###### zh.table.filterIsNot

```ts
readonly table.filterIsNot: "{label}不是{value}";
```

###### zh.table.filterIsNotEmpty

```ts
readonly table.filterIsNotEmpty: "{label}不为空";
```

###### zh.table.filterLessThan

```ts
readonly table.filterLessThan: "{label}小于{value}";
```

###### zh.table.filterNot

```ts
readonly table.filterNot: "非{label}";
```

###### zh.table.filterOr

```ts
readonly table.filterOr: "或者";
```

###### zh.table.filterRecords

```ts
readonly table.filterRecords: "筛选记录";
```

###### zh.table.filterRemove

```ts
readonly table.filterRemove: "移除筛选条件";
```

###### zh.table.filters

```ts
readonly table.filters: "筛选条件";
```

###### zh.table.filtersAllMatch

```ts
readonly table.filtersAllMatch: "所有条件必须同时满足。";
```

###### zh.table.fitAll

```ts
readonly table.fitAll: "适应全部";
```

###### zh.table.fitColumn

```ts
readonly table.fitColumn: "适应列宽";
```

###### zh.table.format

```ts
readonly table.format: "格式";
```

###### zh.table.groupBy

```ts
readonly table.groupBy: "分组依据";
```

###### zh.table.hideColumn

```ts
readonly table.hideColumn: "隐藏列";
```

###### zh.table.import

```ts
readonly table.import: "导入";
```

###### zh.table.integrations

```ts
readonly table.integrations: "集成";
```

###### zh.table.linksTo

```ts
readonly table.linksTo: "关联到{target}";
```

###### zh.table.loadError

```ts
readonly table.loadError: "出错了";
```

###### zh.table.loading

```ts
readonly table.loading: "正在加载记录…";
```

###### zh.table.loadingRecord

```ts
readonly table.loadingRecord: "正在加载记录…";
```

###### zh.table.metadataError

```ts
readonly table.metadataError: "没有 {collection} 的字段元数据。";
```

###### zh.table.nextPage

```ts
readonly table.nextPage: "下一页";
```

###### zh.table.noApprovalRequest

```ts
readonly table.noApprovalRequest: "没有审批请求";
```

###### zh.table.noApprovalRequestDesc

```ts
readonly table.noApprovalRequestDesc: "此记录尚无审批流程活动。";
```

###### zh.table.noCustomView

```ts
readonly table.noCustomView: "没有自定义记录视图";
```

###### zh.table.noCustomViewDesc

```ts
readonly table.noCustomViewDesc: "此集合没有专用的界面表示。使用原始视图检查其字段。";
```

###### zh.table.noFiltersApplied

```ts
readonly table.noFiltersApplied: "未应用筛选条件。";
```

###### zh.table.noIntegrationsConfigured

```ts
readonly table.noIntegrationsConfigured: "未配置集成";
```

###### zh.table.noIntegrationsDescription

```ts
readonly table.noIntegrationsDescription: "此集合当前未连接到外部集成。";
```

###### zh.table.noPipelinesConfigured

```ts
readonly table.noPipelinesConfigured: "未配置{kind}流程";
```

###### zh.table.noPipelinesDeclared

```ts
readonly table.noPipelinesDeclared: "此集合当前未声明{kind}流程。";
```

###### zh.table.noValueNeeded

```ts
readonly table.noValueNeeded: "无需值";
```

###### zh.table.openCollectionActions

```ts
readonly table.openCollectionActions: "打开集合操作";
```

###### zh.table.pageOf

```ts
readonly table.pageOf: "第 {page} 页，共 {pages} 页";
```

###### zh.table.pageSizeDisabled

```ts
readonly table.pageSizeDisabled: "每页行数已禁用";
```

###### zh.table.pendingApproval

```ts
readonly table.pendingApproval: "等待审批";
```

###### zh.table.pendingSync

```ts
readonly table.pendingSync: "尚未保存，等待同步";
```

###### zh.table.perPage

```ts
readonly table.perPage: "/ 页";
```

###### zh.table.pinColumn

```ts
readonly table.pinColumn: "固定列";
```

###### zh.table.pipelineDescription

```ts
readonly table.pipelineDescription: "{label} {kind}流程。";
```

###### zh.table.pipelineFailed

```ts
readonly table.pipelineFailed: "{label}执行失败";
```

###### zh.table.pipelineSelectRows

```ts
readonly table.pipelineSelectRows: "选择一行或多行以运行{label}。";
```

###### zh.table.previousPage

```ts
readonly table.previousPage: "上一页";
```

###### zh.table.rawRegion

```ts
readonly table.rawRegion: "{title} 原始数据";
```

###### zh.table.recordDescription

```ts
readonly table.recordDescription: "{name} 记录";
```

###### zh.table.recordDetails

```ts
readonly table.recordDetails: "{name} 记录详情";
```

###### zh.table.recordLoadFailed

```ts
readonly table.recordLoadFailed: "无法加载记录";
```

###### zh.table.recordLocked

```ts
readonly table.recordLocked: "应用锁定 — 此记录不能再更改";
```

###### zh.table.recordsRegion

```ts
readonly table.recordsRegion: "记录列表";
```

###### zh.table.recordUnavailable

```ts
readonly table.recordUnavailable: "此记录已不可用。";
```

###### zh.table.refresh

```ts
readonly table.refresh: "刷新数据";
```

###### zh.table.refreshFailed

```ts
readonly table.refreshFailed: "刷新失败";
```

###### zh.table.reject

```ts
readonly table.reject: "驳回";
```

###### zh.table.reorderColumns

```ts
readonly table.reorderColumns: "调整列顺序";
```

###### zh.table.requestChanges

```ts
readonly table.requestChanges: "请求变更";
```

###### zh.table.requestChangesDescription

```ts
readonly table.requestChangesDescription: "请说明在此请求获得批准前需要更改的内容。";
```

###### zh.table.requesting

```ts
readonly table.requesting: "正在请求…";
```

###### zh.table.resetWidth

```ts
readonly table.resetWidth: "重置列宽";
```

###### zh.table.resizeColumn

```ts
readonly table.resizeColumn: "调整列宽";
```

###### zh.table.reviewDeletion

```ts
readonly table.reviewDeletion: "确认删除";
```

###### zh.table.rowActions

```ts
readonly table.rowActions: "行操作";
```

###### zh.table.rowCount

```ts
readonly table.rowCount: "共 {count} 行";
```

###### zh.table.rowsPerPage

```ts
readonly table.rowsPerPage: "每页行数";
```

###### zh.table.rowsRegion

```ts
readonly table.rowsRegion: "表格行区域";
```

###### zh.table.run

```ts
readonly table.run: "运行";
```

###### zh.table.runPipeline

```ts
readonly table.runPipeline: "运行{label}";
```

###### zh.table.searchActive

```ts
readonly table.searchActive: "搜索已应用";
```

###### zh.table.searchFields

```ts
readonly table.searchFields: "搜索字段…";
```

###### zh.table.searchFieldsOverflow

```ts
readonly table.searchFieldsOverflow: "{fields} 等 {count} 项";
```

###### zh.table.searchIn

```ts
readonly table.searchIn: "搜索{fields}…";
```

###### zh.table.searchRecords

```ts
readonly table.searchRecords: "搜索记录";
```

###### zh.table.selectAllRows

```ts
readonly table.selectAllRows: "全选所有行";
```

###### zh.table.selectedCount

```ts
readonly table.selectedCount: "已选择 {count} 项";
```

###### zh.table.selectedFraction

```ts
readonly table.selectedFraction: "已选择 {selected} / {total} 项";
```

###### zh.table.selectedRecord

```ts
readonly table.selectedRecord: "已选择 {count} 条记录";
```

###### zh.table.selectedRecords

```ts
readonly table.selectedRecords: "已选择 {count} 条记录";
```

###### zh.table.selectFieldPlaceholder

```ts
readonly table.selectFieldPlaceholder: "选择基础字段或关联字段";
```

###### zh.table.selectRecordLabel

```ts
readonly table.selectRecordLabel: "选择{label}";
```

###### zh.table.selectRow

```ts
readonly table.selectRow: "选择该行";
```

###### zh.table.showColumn

```ts
readonly table.showColumn: "显示列";
```

###### zh.table.sizing

```ts
readonly table.sizing: "尺寸";
```

###### zh.table.sortAscending

```ts
readonly table.sortAscending: "升序排列";
```

###### zh.table.sortClear

```ts
readonly table.sortClear: "清除排序";
```

###### zh.table.sortClearLabel

```ts
readonly table.sortClearLabel: "清除{label}的排序";
```

###### zh.table.sortDescending

```ts
readonly table.sortDescending: "降序排列";
```

###### zh.table.sortLabelAscending

```ts
readonly table.sortLabelAscending: "将{label}升序排列";
```

###### zh.table.sortLabelDescending

```ts
readonly table.sortLabelDescending: "将{label}降序排列";
```

###### zh.table.supersedeApproval

```ts
readonly table.supersedeApproval: "越级完成审批";
```

###### zh.table.supersedeApprovalDescription

```ts
readonly table.supersedeApprovalDescription: "完成所有剩余审批阶段。这是例外操作，并会记录在审计日志中。";
```

###### zh.table.supersedeReason

```ts
readonly table.supersedeReason: "越级完成原因";
```

###### zh.table.supersedeReasonPlaceholder

```ts
readonly table.supersedeReasonPlaceholder: "说明为何需要跳过剩余审核";
```

###### zh.table.supersedingApproval

```ts
readonly table.supersedingApproval: "正在越级完成…";
```

###### zh.table.systemFields

```ts
readonly table.systemFields: "系统字段";
```

###### zh.table.systemLock

```ts
readonly table.systemLock: "系统";
```

###### zh.table.systemLockPendingApproval

```ts
readonly table.systemLockPendingApproval: "系统锁定 — 等待审批";
```

###### zh.table.tabApproval

```ts
readonly table.tabApproval: "审批";
```

###### zh.table.tabRaw

```ts
readonly table.tabRaw: "原始数据";
```

###### zh.table.tabUi

```ts
readonly table.tabUi: "界面";
```

###### zh.table.toolbarRegion

```ts
readonly table.toolbarRegion: "集合工具栏";
```

###### zh.table.unableToLoadRecords

```ts
readonly table.unableToLoadRecords: "无法加载记录";
```

###### zh.table.ungroup

```ts
readonly table.ungroup: "取消分组";
```

###### zh.table.unpinColumn

```ts
readonly table.unpinColumn: "取消固定列";
```

###### zh.table.viewDisabled

```ts
readonly table.viewDisabled: "此视图当前不接受更改。";
```

###### zh.table.withdrawRequest

```ts
readonly table.withdrawRequest: "撤回请求";
```
