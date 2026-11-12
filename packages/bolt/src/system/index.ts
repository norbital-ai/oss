// Built-in declarations share the normal model compiler. The build emits their exact names types separately.
import type { ExposureSpec, ModelParts, ModelSpec } from '../decl/model.ts';
import { split_system_model } from '../decl/model-data.ts';
import type { RelationshipSpec } from '../decl/names.ts';
import type { IntegrationSpec } from '../decl/runtime/integration.ts';
import m_approval_request from './data/model/approval_request/+model.ts';
import m_requestor from './data/model/requestor/+model.ts';
import m_sys_api_key from './data/model/sys_api_key/+model.ts';
import m_sys_challenge from './data/model/sys_challenge/+model.ts';
import m_sys_config from './data/model/sys_config/+model.ts';
import m_sys_conversation from './data/model/sys_conversation/+model.ts';
import m_sys_envoy from './data/model/sys_envoy/+model.ts';
import m_sys_file from './data/model/sys_file/+model.ts';
import m_sys_inbox from './data/model/sys_inbox/+model.ts';
import m_sys_integration from './data/model/sys_integration/+model.ts';
import m_sys_invitation from './data/model/sys_invitation/+model.ts';
import m_sys_message from './data/model/sys_message/+model.ts';
import m_sys_notification from './data/model/sys_notification/+model.ts';
import m_sys_outbox from './data/model/sys_outbox/+model.ts';
import m_sys_run from './data/model/sys_run/+model.ts';
import m_sys_session from './data/model/sys_session/+model.ts';
import m_sys_sync from './data/model/sys_sync/+model.ts';
import m_sys_sync_row from './data/model/sys_sync_row/+model.ts';
import m_sys_user from './data/model/sys_user/+model.ts';
import i_chat from './integration/chat/+integration.ts';
import i_discord from './integration/discord/+integration.ts';
import i_email from './integration/email/+integration.ts';
import i_slack from './integration/slack/+integration.ts';
import i_telegram from './integration/telegram/+integration.ts';
import i_wechat from './integration/wechat/+integration.ts';
import i_whatsapp from './integration/whatsapp/+integration.ts';

const parts = [
	m_approval_request,
	m_requestor,
	m_sys_api_key,
	m_sys_challenge,
	m_sys_config,
	m_sys_conversation,
	m_sys_envoy,
	m_sys_file,
	m_sys_inbox,
	m_sys_integration,
	m_sys_invitation,
	m_sys_message,
	m_sys_notification,
	m_sys_outbox,
	m_sys_run,
	m_sys_session,
	m_sys_sync,
	m_sys_sync_row,
	m_sys_user
].map((m): [string, ModelParts] => [m.name, split_system_model(m.name, m.spec)]);
/** The layer's manifest: merged into every workspace's schema plan, catalogue and names. */
export const SYSTEM: {
	models: { readonly [model: string]: ModelSpec };
	relationships: { readonly [key: string]: RelationshipSpec };
	exposures: { readonly [model: string]: ExposureSpec };
	integrations: { readonly [integration: string]: IntegrationSpec };
} = {
	models: Object.fromEntries(parts.map(([name, p]): [string, ModelSpec] => [name, p.model])),
	relationships: Object.fromEntries(parts.flatMap(([, p]) => Object.entries(p.relationships))),
	exposures: Object.fromEntries(
		parts.flatMap(([name, p]): [string, ExposureSpec][] =>
			p.exposure === undefined ? [] : [[name, p.exposure]]
		)
	),
	integrations: {
		chat: i_chat.spec,
		discord: i_discord.spec,
		email: i_email.spec,
		slack: i_slack.spec,
		telegram: i_telegram.spec,
		wechat: i_wechat.spec,
		whatsapp: i_whatsapp.spec
	}
};
