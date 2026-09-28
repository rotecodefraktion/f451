import type { Messages } from '../../types.js'

/** Englisches Gegenstück zu `messages/de/errors.ts`. */
export const errors: Messages['errors'] = {
  bad_request: 'Invalid input.',
  unauthorized: 'Sign-in required.',
  forbidden: 'No write access to this space.',
  not_found: 'Not found.',
  conflict: 'Conflicts with the current state.',
  payload_too_large: 'File is too large.',
  unsupported_media_type: 'File type is not supported.',
  error: 'Something went wrong — please try again.',
}
