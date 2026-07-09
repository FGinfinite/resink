export type NotificationPreferencesSchema = {
  commentOnOwnProject: boolean
  commentOnInvitedProject: boolean
  repliesOnAuthoredThread: boolean
  repliesOnParticipatingThread: boolean
  commentResolvedOnAuthoredThread: boolean
  commentResolvedOnParticipatingThread: boolean
  commentReopenedOnAuthoredThread: boolean
  commentReopenedOnParticipatingThread: boolean
  trackedChangesOnOwnProject: boolean
  trackedChangesOnInvitedProject: boolean
  trackChangesAcceptedOnAuthoredChange: boolean
  trackChangesRejectedOnAuthoredChange: boolean
}

export type GlobalNotificationPreferencesSchema =
  NotificationPreferencesSchema & {
    muteAllNotifications: boolean
  }
