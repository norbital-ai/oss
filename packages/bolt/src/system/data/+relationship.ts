// The built-in layer's references (§5.11.1): the team tree, a member's team, who issued a key or an invitation, a
// session's member (deleted with it) and a requestor's approval request.
import { relationship } from '../../decl/relationship.ts';

export default relationship({
	'sys_channel_connection.owner': { to: 'sys_user', optional: true },
	'sys_envoy_channel.envoy': { to: 'sys_envoy', onDelete: 'cascade' },
	'sys_envoy_channel.channel_connection': { to: 'sys_channel_connection', onDelete: 'cascade' },
	'sys_team.parent': { to: 'sys_team', optional: true },
	'sys_user.team': { to: 'sys_team', optional: true },
	'sys_api_key.created_by': { to: 'sys_user', optional: true },
	'sys_invitation.team': { to: 'sys_team', optional: true },
	'sys_invitation.invited_by': { to: 'sys_user', optional: true },
	'sys_session.user': { to: 'sys_user', onDelete: 'cascade' },
	'sys_session.impersonated_by': { to: 'sys_user', optional: true },
	'requestor.approval_request_id': { to: 'approval_request' },
});
