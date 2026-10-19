// The built-in layer's references (§5.11.1): the team tree, a member's team, who issued a key or an invitation, a
// session's member (deleted with it), a requestor's approval request, a personal instance's member, and the instance
// a conversation and its messages travel on (deleted with it).
import { relationship } from '../../decl/relationship.ts';

export default relationship({
	'sys_integration.owner': { to: 'sys_user', optional: true },
	'sys_conversation.integration': { to: 'sys_integration', optional: true, onDelete: 'cascade' },
	'sys_message.integration': { to: 'sys_integration', optional: true, onDelete: 'cascade' },
	'sys_team.parent': { to: 'sys_team', optional: true },
	'sys_user.team': { to: 'sys_team', optional: true },
	'sys_api_key.created_by': { to: 'sys_user', optional: true },
	'sys_api_key.team': { to: 'sys_team', optional: true },
	'sys_invitation.team': { to: 'sys_team', optional: true },
	'sys_invitation.invited_by': { to: 'sys_user', optional: true },
	'sys_session.user': { to: 'sys_user', onDelete: 'cascade' },
	'sys_session.impersonated_by': { to: 'sys_user', optional: true },
	'requestor.approval_request_id': { to: 'approval_request' }
});
