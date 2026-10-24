export function channelApprovalSettings(options?: { internal?: boolean }): {
  approvalPolicy: 'on-request' | 'never'
  approvalsReviewer?: 'auto_review'
}
