import { describe, it, expect } from 'vitest'
import { isWorksourceDevChannelModal } from '../web/agent-process.js'

const modal = (channels: string, cursor = '❯ 1.') => `
  --dangerously-load-development-channels is for local channel development
  only. Do not use this option to run channels you have downloaded off the
  internet.

  Please use --channels to run a list of approved channels.

  Channels: ${channels}

  ${cursor} I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
`

describe('isWorksourceDevChannelModal', () => {
  it('matches the modal naming only worksource', () => {
    expect(isWorksourceDevChannelModal(modal('server:worksource'))).toBe(true)
  })
  it('refuses a modal naming another channel too', () => {
    expect(isWorksourceDevChannelModal(modal('server:worksource, server:evil'))).toBe(false)
    expect(isWorksourceDevChannelModal(modal('server:evil'))).toBe(false)
  })
  it('refuses when the cursor is not on option 1', () => {
    expect(isWorksourceDevChannelModal(modal('server:worksource', '  1.'))).toBe(false)
  })
  it('ignores an ordinary idle pane', () => {
    expect(isWorksourceDevChannelModal('❯ \n  Opus | ctx 9%')).toBe(false)
  })
})
