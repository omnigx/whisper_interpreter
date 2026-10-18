/**
 * App-wide debug mode.
 *
 * On: session logs go to logs/logs_debug/ and recordings to
 * recordings/recordings_debug/ (same parents, subfolders) so routine
 * meeting material stays separate from debug captures. Everything else
 * (formats, fields, pairing stamps) is unchanged.
 */

let debugMode = false

export function isDebugMode(): boolean {
  return debugMode
}

/** Returns the new state. The caller rotates the session log so subsequent
 *  entries land in the newly selected folder. */
export function setDebugMode(v: boolean): boolean {
  debugMode = v
  return debugMode
}

export const DEBUG_SUBDIR = 'logs_debug'
export const RECORDINGS_DEBUG_SUBDIR = 'recordings_debug'
