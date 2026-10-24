const OWNER_CHANNEL = Object.freeze({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })
const BACKGROUND = Object.freeze({ approvalPolicy: 'never' })

export function channelApprovalSettings({ internal = false } = {}) {
  return internal ? BACKGROUND : OWNER_CHANNEL
}
