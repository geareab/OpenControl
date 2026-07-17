/**
 * Legacy fixed-port exports retained for the temporary `openmicro` alias.
 * OpenControl production hosts bind port 0 and publish the chosen port through
 * the authenticated runtime descriptor (see runtime.ts).
 */
export const HOST_PORT = 48762
export const HOST_URL = `http://127.0.0.1:${HOST_PORT}`

/** Legacy OpenMicro hook path, accepted only with bearer authentication. */
export const HOOK_PATH = '/om-hook/'
export const HOOK_URL = `${HOST_URL}${HOOK_PATH}`

export const API_PATHS = {
  health: '/health',
  register: '/api/v1/register',
  hookPrefix: '/api/v1/hooks/',
  control: '/api/v1/control',
  status: '/api/v1/status',
  instancePrefix: '/api/v1/instances/',
} as const
