// An envoy's binding to a workspace conversation channel (`sys_integration`): multiple envoys may share one paired
// channel (e.g. one WhatsApp number or Slack bot), each scoped to specific groups, teams, members or handles (`scope`).
// Admission matches inbound messages to the most specific active binding on that channel.
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_envoy_channel')({
	description: "An envoy's channel binding and listening scope on a workspace conversation account.",
	record_label: 'record.id',
	fields: {
		envoy: { kind: 'ref', to: 'sys_envoy', on_delete: 'cascade' },
		integration: { kind: 'ref', to: 'sys_integration', on_delete: 'cascade' },
		/** Per-channel listening scope (`ListeningScope`); null inherits all DMs and groups allowed by the envoy. */
		scope: { kind: 'json', optional: true },
		/** Optional override for group trigger mode on this channel; null inherits `sys_envoy.group_messages`. */
		group_messages: {
			kind: 'enum',
			values: ['disabled', 'mention_or_reply', 'all'],
			optional: true
		},
		active: { kind: 'bool', default: true },
		revision: { kind: 'int', default: 1 }
	},
	constraints: {
		one_per_envoy_channel: { unique: ['envoy', 'integration'] }
	},
	table: { primary: 'uuid' },
	outputs: { default: { fields: 'all' } },
	create: { fields: ['envoy', 'integration', 'scope', 'group_messages', 'active'] },
	update: { fields: ['scope', 'group_messages', 'active'] },
	delete: {}
});
