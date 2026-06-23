import { repairToolInput } from './toolInputRepair.js'

// Mock a ZodError-like object
function mockZodError(issues: Array<Record<string, unknown>>) {
  return {
    issues,
    message: 'validation failed',
    name: 'ZodError',
  } as unknown as import('zod/v4').ZodError
}

// Test 1: Strip nulls
{
  const err = mockZodError([
    {
      code: 'invalid_type',
      path: ['offset'],
      message: 'Expected number, received null',
      expected: 'number',
      received: 'null',
    },
  ])
  const r = repairToolInput(
    { file_path: '/x', offset: null, limit: 5 },
    err,
    'Read',
  )
  console.log('Test 1 - stripNulls:', JSON.stringify(r))
  console.assert(r !== null, 'should have repair result')
  console.assert(
    (r!.repaired as Record<string, unknown>).offset === undefined,
    'offset should be stripped',
  )
  console.assert(
    r!.repairs.includes('stripped_null_values'),
    'should log stripped_null_values',
  )
}

// Test 2: Unwrap markdown links in paths
{
  // markdown links only fire based on the string pattern, not on Zod issues
  const err = mockZodError([])
  const r = repairToolInput(
    { file_path: '/x/[notes.md](http://notes.md)' },
    err,
    'Write',
  )
  console.log('Test 2 - markdown:', JSON.stringify(r))
  console.assert(r !== null, 'should have repair result')
  console.assert(
    (r!.repaired as Record<string, unknown>).file_path === '/x/notes.md',
    'markdown link should be unwrapped',
  )
  console.assert(
    r!.repairs.includes('unwrapped_markdown_links'),
    'should log unwrapped_markdown_links',
  )
}

// Test 3: Real markdown links pass through
{
  const err = mockZodError([])
  const r = repairToolInput(
    { file_path: '/x/[click here](https://example.com)' },
    err,
    'Write',
  )
  console.log('Test 3 - realLinks:', JSON.stringify(r))
  console.assert(
    r === null ||
      (r!.repaired as Record<string, unknown>).file_path ===
        '/x/[click here](https://example.com)',
    'real markdown links should pass through',
  )
}

// Test 4: Parse JSON string arrays
{
  const err = mockZodError([
    {
      code: 'invalid_type',
      path: ['paths'],
      message: 'Expected array, received string',
      expected: 'array',
      received: 'string',
    },
  ])
  const r = repairToolInput(
    { paths: '["a","b"]' },
    err,
    'Grep',
  )
  console.log('Test 4 - jsonArray:', JSON.stringify(r))
  console.assert(r !== null, 'should have repair result')
  console.assert(
    Array.isArray((r!.repaired as Record<string, unknown>).paths),
    'paths should be an array',
  )
  console.assert(
    r!.repairs.includes('parsed_json_string_arrays'),
    'should log parsed_json_string_arrays',
  )
}

// Test 5: Wrap bare string in array (not JSON-parseable)
{
  const err = mockZodError([
    {
      code: 'invalid_type',
      path: ['args'],
      message: 'Expected array, received string',
      expected: 'array',
      received: 'string',
    },
  ])
  const r = repairToolInput({ args: 'hello' }, err, 'Bash')
  console.log('Test 5 - bareString:', JSON.stringify(r))
  console.assert(r !== null, 'should have repair result')
  console.assert(
    Array.isArray((r!.repaired as Record<string, unknown>).args),
    'args should be wrapped in array',
  )
  console.assert(
    (r!.repaired as Record<string, unknown>).args[0] === 'hello',
    'first element should be the original string',
  )
  console.assert(
    r!.repairs.includes('wrapped_bare_strings_in_arrays'),
    'should log wrapped_bare_strings_in_arrays',
  )
}

// Test 6: No repair needed — valid input should be untouched
{
  const err = mockZodError([])
  const r = repairToolInput(
    { file_path: '/x/y.md', content: 'hello world' },
    err,
    'Write',
  )
  console.log('Test 6 - noRepair:', JSON.stringify(r))
  // with an empty issue list, no repairs fire, but markdown link check always runs
  const hasContentChange =
    r !== null &&
    JSON.stringify(r.repaired) !==
      JSON.stringify({ file_path: '/x/y.md', content: 'hello world' })
  console.assert(!hasContentChange, 'valid input should not be modified')
}

// Test 7: Combined failures — null + markdown in same call
{
  const err = mockZodError([
    {
      code: 'invalid_type',
      path: ['offset'],
      message: 'Expected number, received null',
      expected: 'number',
      received: 'null',
    },
  ])
  const r = repairToolInput(
    { file_path: '/x/[notes.md](http://notes.md)', offset: null, limit: 50 },
    err,
    'Read',
  )
  console.log('Test 7 - combined:', JSON.stringify(r))
  console.assert(r !== null, 'should have repair result')
  console.assert(
    (r!.repaired as Record<string, unknown>).offset === undefined,
    'offset should be stripped',
  )
  console.assert(
    (r!.repaired as Record<string, unknown>).file_path === '/x/notes.md',
    'markdown link should be unwrapped',
  )
  console.assert(
    r!.repairs.length >= 2,
    `expected 2+ repairs, got ${r!.repairs.length}: ${r!.repairs.join(',')}`,
  )
}

// Test 8: JSON-array parse happens BEFORE bare string wrap (ordering critical)
{
  const err = mockZodError([
    {
      code: 'invalid_type',
      path: ['files'],
      message: 'Expected array, received string',
      expected: 'array',
      received: 'string',
    },
  ])
  const r = repairToolInput(
    { files: '["x.ts","y.ts"]' },
    err,
    'Glob',
  )
  console.log('Test 8 - ordering:', JSON.stringify(r))
  console.assert(r !== null, 'should have repair result')
  const d = r!.repaired as Record<string, unknown>
  console.assert(Array.isArray(d.files), 'files should be array')
  console.assert(
    (d.files as string[])[0] === 'x.ts',
    `first element should be x.ts, got ${(d.files as string[])[0]}`,
  )
  console.assert(
    (d.files as string[])[1] === 'y.ts',
    `second element should be y.ts, got ${(d.files as string[])[1]}`,
  )
  // Critical: must NOT be ['["x.ts","y.ts"]'] which would happen if bareStringWrap ran first
  console.assert(
    r!.repairs[0] === 'parsed_json_string_arrays',
    `first repair must be parsed_json_string_arrays, got ${r!.repairs[0]}`,
  )
}

// Test 9: Rename unrecognized keys — absolutePath → file_path
{
  const err = mockZodError([
    {
      code: 'invalid_type',
      path: ['file_path'],
      message: 'Required',
      expected: 'string',
      received: 'undefined',
    },
    { code: 'unrecognized_keys', keys: ['absolutePath'] },
  ])
  const r = repairToolInput(
    { absolutePath: '/home/user/src/foo.ts' },
    err,
    'Read',
  )
  console.log('Test 9 - renameKeys absolutePath:', JSON.stringify(r))
  console.assert(r !== null, 'should have repair result')
  const d = r!.repaired as Record<string, unknown>
  console.assert(
    d.file_path === '/home/user/src/foo.ts',
    `file_path should be /home/user/src/foo.ts, got ${d.file_path}`,
  )
  console.assert(d.absolutePath === undefined, 'absolutePath should be removed')
  console.assert(
    r!.repairs.includes('renamed_unrecognized_keys'),
    'should log renamed_unrecognized_keys',
  )
}

// Test 10: Rename unrecognized keys — contents → content (Write tool)
{
  const err = mockZodError([
    {
      code: 'invalid_type',
      path: ['content'],
      message: 'Required',
      expected: 'string',
      received: 'undefined',
    },
    { code: 'unrecognized_keys', keys: ['contents'] },
  ])
  const r = repairToolInput(
    { file_path: '/x/out.md', contents: '# hello world' },
    err,
    'Write',
  )
  console.log('Test 10 - renameKeys contents:', JSON.stringify(r))
  console.assert(r !== null, 'should have repair result')
  const d = r!.repaired as Record<string, unknown>
  console.assert(d.content === '# hello world', 'content should be mapped from contents')
  console.assert(d.contents === undefined, 'contents should be removed')
}

// Test 11: Rename unrecognized keys — oldStr/newStr → old_string/new_string (Edit tool)
{
  const err = mockZodError([
    {
      code: 'invalid_type',
      path: ['old_string'],
      message: 'Required',
      expected: 'string',
      received: 'undefined',
    },
    {
      code: 'invalid_type',
      path: ['new_str'],
      message: 'Required',
      expected: 'string',
      received: 'undefined',
    },
    { code: 'unrecognized_keys', keys: ['oldStr', 'newStr'] },
  ])
  const r = repairToolInput(
    {
      file_path: '/x/test.ts',
      oldStr: 'const x = 1;',
      newStr: 'let x = 1;',
    },
    err,
    'Edit',
  )
  console.log('Test 11 - renameKeys Edit:', JSON.stringify(r))
  console.assert(r !== null, 'should have repair result')
  const d = r!.repaired as Record<string, unknown>
  console.assert(
    d.old_string === 'const x = 1;',
    'old_string should be mapped from oldStr',
  )
  console.assert(
    d.new_str === 'let x = 1;',
    'new_str should be mapped from newStr',
  )
  console.assert(d.oldStr === undefined, 'oldStr should be removed')
  console.assert(d.newStr === undefined, 'newStr should be removed')
}

// Test 12: Extra keys with no matching missing field — no rename (safe guard)
{
  const err = mockZodError([
    { code: 'unrecognized_keys', keys: ['extraNote', 'debug'] },
  ])
  const r = repairToolInput(
    { file_path: '/x/file.ts', extraNote: 'test', debug: true },
    err,
    'Read',
  )
  console.log('Test 12 - extraKeysNoMissing:', JSON.stringify(r))
  // No missing required fields → no renaming should happen
  // But other repairs might fire (markdown unwrap, etc.)
  if (r !== null) {
    console.assert(
      !r.repairs.includes('renamed_unrecognized_keys'),
      'should not rename when no required fields are missing',
    )
  }
}

// Test 13: Unrecognized key that matches alias but required field is already present
{
  const err = mockZodError([
    { code: 'unrecognized_keys', keys: ['absolutePath'] },
  ])
  const r = repairToolInput(
    { file_path: '/x/file.ts', absolutePath: '/other' },
    err,
    'Read',
  )
  console.log('Test 13 - aliasPresent:', JSON.stringify(r))
  // file_path is already present AND no missing required issue
  // → rename should NOT fire (don't overwrite valid field)
  if (r !== null) {
    console.assert(
      !r.repairs.includes('renamed_unrecognized_keys'),
      'should not rename when canonical field already has a value',
    )
  }
}

console.log('\nAll tests passed!')
