// HOSTINGERDOCKER1107: how this install is deployed. The container's first start writes MARVEEN_DEPLOYMENT=docker into
// .env (docker/first-boot.sh); there the image owns the code and the claude CLI version, so nothing in the dashboard
// may run update.sh or install a CLI: a new version is a new image.
import { readEnvFile } from '../env.js'

export type Deployment = 'docker' | 'native'

export function deployment(read: (keys: string[]) => Record<string, string> = readEnvFile): Deployment {
  return read(['MARVEEN_DEPLOYMENT']).MARVEEN_DEPLOYMENT === 'docker' ? 'docker' : 'native'
}

export const MANAGED_BY_IMAGE = {
  error: 'This Marveen runs in a container, and its image owns the version. Update it with a new image: docker compose pull && docker compose up -d',
  reason: 'managed-by-image',
} as const
