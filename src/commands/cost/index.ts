// /cost command stripped (Anthropic billing removed)
const cost = { name: 'cost', description: 'Show session cost', type: 'local' as const, isEnabled: () => false, load: () => import('./cost.js') }
export default cost
