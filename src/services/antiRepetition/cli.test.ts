import { expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { loadTranscriptFile } from '../../utils/sessionStorage.js'
import { sanitizePath } from '../../utils/path.js'

const binary = resolve(import.meta.dir, '../../../claudium-cli')
const cliTest = existsSync(binary) ? test : test.skip

for (const format of ['stream-json', 'json'] as const) {
cliTest(`compiled headless CLI withdraws failed output and resumes the task (${format})`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claudium-antirep-cli-'))
  const requests: any[] = []
  let canceled = 0
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const body = await request.json() as any
      requests.push(body)
      const looping = requests.length === 1
      const id = looping ? 'bad-response' : 'good-response'
      const events: any[] = [
        { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'fixture-model', content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      ]
      if (looping) {
        events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Failed completed thinking fixture.' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'failed-signature' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
          ...Array.from({ length: 1000 }, () => ({ type: 'content_block_delta', index: 1,
            delta: { type: 'thinking_delta', thinking: 'Let me reconsider. ' } })),
        )
      } else {
        events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered task result.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        )
      }
      const encoder = new TextEncoder()
      let position = 0
      return new Response(new ReadableStream({
        async pull(controller) {
          const event = events[position++]
          if (!event) { controller.close(); return }
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
          await new Promise(resolve => setTimeout(resolve, 1))
        },
        cancel() { if (looping) canceled++ },
      }), { headers: { 'content-type': 'text/event-stream', 'request-id': id } })
    },
  })
  try {
    const child = Bun.spawn([binary, '--bare', '-p', 'Complete the fixture task.', '--model', 'fixture-model',
      '--tools', '', '--setting-sources', '',
      '--settings', JSON.stringify({ antiRepetition: { enabled: true } }),
      '--system-prompt', 'Complete the task.', '--verbose', '--output-format', format,
      ...(format === 'stream-json' ? ['--include-partial-messages'] : [])], {
      cwd: home,
      env: { ...process.env, CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        ANTHROPIC_API_KEY: 'fixture-only-key', ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('Unhandled')
    const output: any[] = format === 'stream-json'
      ? stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : JSON.parse(stdout)
    if (format === 'stream-json') {
      const reset = output.find(message => message.type === 'system' && message.subtype === 'stream_reset')
      expect(reset).toMatchObject({ reason: 'REASONING_LOOP', recovering: true })
      expect(reset.withdrawn_message_ids).toHaveLength(1)
    } else {
      expect(JSON.stringify(output)).not.toContain('failed-signature')
      expect(JSON.stringify(output)).not.toContain('Failed completed thinking fixture')
    }
    expect(output.at(-1)).toMatchObject({ type: 'result', is_error: false, result: 'Recovered task result.' })
    expect(requests).toHaveLength(2)
    expect(requests.every(request => request.stream)).toBe(true)
    const recoveredHistory = JSON.stringify(requests[1].messages)
    expect(recoveredHistory).not.toContain('failed-signature')
    expect(recoveredHistory).not.toContain('Failed completed thinking fixture')
    expect(recoveredHistory).toContain('Complete the fixture task.')
    expect(recoveredHistory).toContain('REASONING_LOOP')
    expect(canceled).toBe(1)
    const sessionId = output.at(-1).session_id
    const transcript = await loadTranscriptFile(join(home, 'projects', sanitizePath(home), `${sessionId}.jsonl`))
    const resumed = JSON.stringify([...transcript.messages.values()])
    expect(transcript.messages.size).toBeGreaterThan(0)
    expect(resumed).not.toContain('failed-signature')
    expect(resumed).not.toContain('Failed completed thinking fixture')
    expect(resumed).toContain('Recovered task result.')
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 30000)
}
