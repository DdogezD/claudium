import { afterEach, expect, test } from 'bun:test'
import {
  type CacheSafeParams,
  getLastCacheSafeParams,
  saveCacheSafeParams,
} from './forkedAgent.js'

afterEach(() => {
  saveCacheSafeParams(null)
})

test('releases the cache-safe snapshot when its conversation is replaced', () => {
  const snapshot = {
    forkContextMessages: [{}],
  } as CacheSafeParams

  saveCacheSafeParams(snapshot)
  expect(getLastCacheSafeParams()).toBe(snapshot)

  saveCacheSafeParams(null)
  expect(getLastCacheSafeParams()).toBeNull()
})
