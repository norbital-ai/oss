import { defineMessages } from '@norbital-ai/std/i18n';

export const recordMetadataMessages = defineMessages({
	en: {
		'recordMetadata.readOnly': 'Read only',
		'recordMetadata.updatesRestricted': 'Updates unavailable',
		'recordMetadata.deletionRestricted': 'Deletion unavailable',
		'recordMetadata.pendingApproval': 'Pending approval',
		'recordMetadata.pendingApprovalReason':
			'This record is read-only while its approval request is pending.',
		'recordMetadata.selectedUpdateRestricted': 'The selected records cannot be updated: {reason}',
		'recordMetadata.selectedDeleteRestricted': 'The selected records cannot be deleted: {reason}',
		'recordMetadata.readOnlyMove': 'This record cannot be moved: {reason}'
	},
	zh: {
		'recordMetadata.readOnly': '只读',
		'recordMetadata.updatesRestricted': '无法更新',
		'recordMetadata.deletionRestricted': '无法删除',
		'recordMetadata.pendingApproval': '等待审批',
		'recordMetadata.pendingApprovalReason': '审批请求处理期间，此记录为只读。',
		'recordMetadata.selectedUpdateRestricted': '所选记录无法更新：{reason}',
		'recordMetadata.selectedDeleteRestricted': '所选记录无法删除：{reason}',
		'recordMetadata.readOnlyMove': '此记录无法移动：{reason}'
	}
});
