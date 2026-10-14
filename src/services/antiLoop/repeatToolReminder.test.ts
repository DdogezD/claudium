import { expect, test } from 'bun:test'
import { resolveAntiLoopConfig } from './config.js'
import { createAntiLoopReminderText } from './antiLoopMessages.js'
import { canonicalizeToolArguments, RepeatToolReminderTracker } from './repeatToolReminder.js'

const config = resolveAntiLoopConfig()

 test('canonicalizes nested objects while preserving arrays and strings', () => {
  expect(canonicalizeToolArguments({ z: 1, a: { b: 2, a: ' x ' }, list: [3, 1] }))
    .toBe('{"a":{"a":" x ","b":2},"list":[3,1],"z":1}')
  expect(canonicalizeToolArguments({ value: '01' })).not.toBe(canonicalizeToolArguments({ value: 1 }))
})

test('skips circular and non-JSON arguments without throwing', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(canonicalizeToolArguments(circular)).toBeUndefined()
  expect(canonicalizeToolArguments({ value: 1n })).toBeUndefined()
  const tracker = new RepeatToolReminderTracker(config)
  expect(() => tracker.observe({ toolName: 'Read', input: circular })).not.toThrow()
})

test('reminds exactly at configured thresholds and stops after the last one', () => {
  const tracker = new RepeatToolReminderTracker(config)
  const reminders = Array.from({ length: 9 }, () => tracker.observe({ toolName: 'Read', input: { file: 'a' } }))
    .filter(reminder => reminder !== undefined)
  expect(reminders.map(reminder => reminder.count)).toEqual([3, 5, 8])
  expect(reminders[0]!.thresholdIndex).toBe(0)
  expect(reminders[1]!.thresholdIndex).toBe(1)
  expect(reminders[2]!.thresholdIndex).toBe(2)
})

test('different tracked calls reset the count', () => {
  const tracker = new RepeatToolReminderTracker(config)
  for (let i = 0; i < 2; i++) tracker.observe({ toolName: 'Read', input: { file: 'a' } })
  expect(tracker.observe({ toolName: 'Read', input: { file: 'b' } })).toBeUndefined()
  expect(tracker.observe({ toolName: 'Read', input: { file: 'b' } })).toBeUndefined()
  expect(tracker.observe({ toolName: 'Read', input: { file: 'b' } })?.count).toBe(3)
})

test('detailed reminders include bounded canonical arguments', () => {
  const tracker = new RepeatToolReminderTracker(resolveAntiLoopConfig({ argumentsPreviewChars: 8 }))
  for (let i = 0; i < 5; i++) {
    const reminder = tracker.observe({ toolName: 'Read', input: { long: 'abcdefghijk' } })
    if (reminder?.count === 5) {
      expect(reminder.argumentsPreview.length).toBe(8)
      expect(createAntiLoopReminderText(reminder)).toContain('[Claudium AntiLoop notice]')
    }
  }
})

test('rejects invalid resolver configuration', () => {
  for (const thresholds of [[], [3, 3], [5, 3], [1, 3], [3.5]]) {
    expect(() => resolveAntiLoopConfig({ thresholds })).toThrow()
  }
  expect(() => resolveAntiLoopConfig({ argumentsPreviewChars: 0 })).toThrow()
})
