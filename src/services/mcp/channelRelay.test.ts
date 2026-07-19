import { afterEach, expect, test } from 'bun:test'
import { setAllowedChannels } from '../../bootstrap/state.js'
import {
  createChannelPermissionCallbacks,
  filterPermissionRelayClients,
} from './channelPermissions.js'
import { gateChannelServer } from './channelNotification.js'

const channelCapabilities = {
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},
  },
}

afterEach(() => {
  setAllowedChannels([])
})

test('registers an explicitly selected local server channel', () => {
  setAllowedChannels([{ kind: 'server', name: 'server:telegram' }])

  expect(
    gateChannelServer('server:telegram', channelCapabilities, undefined),
  ).toEqual({ action: 'register' })
})

test('verifies the exact installed source for plugin channels', () => {
  setAllowedChannels([
    { kind: 'plugin', name: 'telegram', marketplace: 'local' },
  ])

  expect(
    gateChannelServer('plugin:telegram:server', channelCapabilities, 'telegram@other'),
  ).toMatchObject({ action: 'skip', kind: 'source' })
  expect(
    gateChannelServer('plugin:telegram:server', channelCapabilities, 'evil@local'),
  ).toMatchObject({ action: 'skip', kind: 'source' })
  expect(
    gateChannelServer('plugin:telegram:server', channelCapabilities, undefined),
  ).toMatchObject({ action: 'skip', kind: 'source' })
  expect(
    gateChannelServer('plugin:telegram:server', channelCapabilities, 'telegram@local'),
  ).toEqual({ action: 'register' })
})

test('outbound permission relay also enforces the full channel gate', () => {
  setAllowedChannels([
    { kind: 'plugin', name: 'telegram', marketplace: 'local' },
  ])
  const clients = [
    {
      type: 'connected',
      name: 'plugin:telegram:server',
      capabilities: channelCapabilities,
      config: { pluginSource: 'telegram@other' },
    },
  ] as const

  expect(
    filterPermissionRelayClients(
      clients,
      name => name === 'plugin:telegram:server',
      client =>
        gateChannelServer(
          client.name,
          client.capabilities,
          client.config.pluginSource,
        ).action === 'register',
    ),
  ).toHaveLength(0)

  expect(
    filterPermissionRelayClients(
      [
        {
          ...clients[0],
          config: { pluginSource: 'evil@local' },
        },
      ],
      name => name === 'plugin:telegram:server',
      client =>
        gateChannelServer(
          client.name,
          client.capabilities,
          client.config.pluginSource,
        ).action === 'register',
    ),
  ).toHaveLength(0)

  expect(
    filterPermissionRelayClients(
      [
        {
          ...clients[0],
          config: { pluginSource: 'telegram@local' },
        },
      ],
      name => name === 'plugin:telegram:server',
      client =>
        gateChannelServer(
          client.name,
          client.capabilities,
          client.config.pluginSource,
        ).action === 'register',
    ),
  ).toHaveLength(1)
})

test('requires channel capabilities and explicit session selection', () => {
  expect(gateChannelServer('server:telegram', channelCapabilities, undefined)).toMatchObject({
    action: 'skip',
    kind: 'session',
  })

  setAllowedChannels([{ kind: 'server', name: 'server:telegram' }])
  expect(
    gateChannelServer(
      'server:telegram',
      { experimental: {} },
      undefined,
    ),
  ).toMatchObject({ action: 'skip', kind: 'capability' })
})

test('resolves channel permission responses once', () => {
  const callbacks = createChannelPermissionCallbacks()
  const responses: string[] = []
  callbacks.onResponse('AbCde', response => {
    responses.push(`${response.behavior}:${response.fromServer}`)
  })

  expect(callbacks.resolve('abcde', 'allow', 'server:telegram')).toBe(true)
  expect(callbacks.resolve('abcde', 'deny', 'server:telegram')).toBe(false)
  expect(responses).toEqual(['allow:server:telegram'])
})

test('filters permission relay clients by connection, selection, and capability', () => {
  const clients = [
    {
      type: 'connected',
      name: 'server:telegram',
      capabilities: channelCapabilities,
    },
    {
      type: 'failed',
      name: 'server:telegram',
      capabilities: channelCapabilities,
    },
    {
      type: 'connected',
      name: 'server:plain',
      capabilities: { experimental: { 'claude/channel': {} } },
    },
  ] as const

  expect(
    filterPermissionRelayClients(clients, name => name === 'server:telegram'),
  ).toHaveLength(1)
})
