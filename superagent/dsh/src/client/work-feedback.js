import { t } from './i18n.js'

const workStatuses = {
  routing: 'Routing work', pending: 'Pending work', running: 'Running work', waiting: 'Waiting for an answer',
  blocked: 'Blocked work', stopped: 'Stopped work', stopping: 'Stopping…', success: 'Work complete',
  failed: 'Work failed', rejected: 'Work declined', accepted: 'Accepted by Router', ended: 'Generation ended',
  unknown: 'Work result unknown',
}

export function workStatusCopy(status) {
  return Object.hasOwn(workStatuses, status) ? t(workStatuses[status]) : status
}
