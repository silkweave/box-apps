// fcmServiceAccount(): the one parser standing between a pasted credential and a transport that
// either runs or silently does not. Absent and malformed both answer null, but malformed must SAY
// so - and must never echo the raw value, which is a private key.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const credential = vi.fn<(channel: string, account: string, key: string) => string | undefined>()

vi.mock('@silkweave/box-core', () => ({
  credential: (...args: [string, string, string]) => credential(...args),
  chatStore: () => {
    throw new Error('chatStore must not be touched by fcmServiceAccount()')
  },
}))

const { fcmServiceAccount } = await import('./fcm.js')

const VALID = {
  project_id: 'silkweave',
  client_email: 'firebase-adminsdk@silkweave.iam.gserviceaccount.com',
  // Not PEM on purpose: the parser only cares that the escaped newlines decode.
  private_key: 'fake-key-line-1\nfake-key-line-2\n',
}

describe('fcmServiceAccount', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    credential.mockReset()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('reads push.*.FCM_SERVICE_ACCOUNT and nothing else', () => {
    credential.mockReturnValue(undefined)
    fcmServiceAccount()
    expect(credential).toHaveBeenCalledExactlyOnceWith('push', '*', 'FCM_SERVICE_ACCOUNT')
  })

  it('absent -> null, silently (the transport is simply off)', () => {
    credential.mockReturnValue(undefined)
    expect(fcmServiceAccount()).toBeNull()
    credential.mockReturnValue('')
    expect(fcmServiceAccount()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('malformed JSON -> null, with a warning that names the fix and never the value', () => {
    const raw = '{"project_id": "silkweave", "private_key": "SECRET-MATERIAL'
    credential.mockReturnValue(raw)
    expect(fcmServiceAccount()).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('not valid JSON')
    expect(message).toContain('device push is OFF')
    expect(message).not.toContain('SECRET-MATERIAL')
  })

  it('valid JSON missing fields -> null, naming every missing field', () => {
    credential.mockReturnValue(JSON.stringify({ project_id: 'silkweave' }))
    expect(fcmServiceAccount()).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('missing client_email, private_key')
    expect(message).not.toContain('project_id')
  })

  it('an empty string counts as missing', () => {
    credential.mockReturnValue(JSON.stringify({ ...VALID, private_key: '' }))
    expect(fcmServiceAccount()).toBeNull()
    expect(String(warn.mock.calls[0]?.[0])).toContain('missing private_key')
  })

  it('the full document -> the three fields, with the escaped newlines decoded by JSON.parse', () => {
    credential.mockReturnValue(JSON.stringify({ ...VALID, type: 'service_account', client_id: '1' }))
    const sa = fcmServiceAccount()
    expect(sa).not.toBeNull()
    expect(sa?.project_id).toBe('silkweave')
    expect(sa?.client_email).toBe(VALID.client_email)
    expect(sa?.private_key).toBe(VALID.private_key)
    expect(sa?.private_key).toContain('\n')
    expect(warn).not.toHaveBeenCalled()
  })
})
