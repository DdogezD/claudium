import { commandHasAnyCd } from '../BashTool/bashPermissions.js'
import { BashTool } from '../BashTool/BashTool.js'
import { checkReadOnlyConstraints } from '../BashTool/readOnlyValidation.js'

type BashInput = ReturnType<typeof BashTool.inputSchema.parse>

export type AdvisorBashPolicyResult =
  | { allowed: true; input: BashInput }
  | { allowed: false; input: unknown; command: string | null }

/** Validate and classify advisor Bash input before allowing it to execute. */
export function validateAdvisorBashInput(input: unknown): AdvisorBashPolicyResult {
  const parsed = BashTool.inputSchema.safeParse(input)
  if (!parsed.success) {
    return { allowed: false, input, command: null }
  }

  const readOnlyCheck = checkReadOnlyConstraints(
    parsed.data,
    commandHasAnyCd(parsed.data.command),
  )
  if (readOnlyCheck.behavior !== 'allow') {
    return { allowed: false, input: parsed.data, command: parsed.data.command }
  }

  return { allowed: true, input: parsed.data }
}
