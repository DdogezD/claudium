import type { SearxngSearchResult } from './searxng.js'

/**
 * Quality layer for the SearXNG search path. Activated only when the SearXNG
 * override is enabled (WebSearchTool gates both the guidance text and the
 * rerank hook on hasSearxngWebSearchOverride).
 *
 * Prompt texts here were validated end-to-end against the user's SearXNG
 * instance (flattened engine weights + BM25 reranker): across 5 query
 * profiles / 46 verdicts the filter agreed with manual judgement on ~95%,
 * collapsing off-topic hits and same-story repost duplicates. Keep rates
 * varied 43–75% by query, so there is deliberately no fixed keep-count or
 * score threshold — the model verdict is the filter.
 */

/** Appended to the search subquery system prompt (SearXNG path only). */
export const SEARXNG_RESULT_GUIDANCE = `处理搜索结果时的要求:
- 来源优先级: 官方文档/一手资料 > 技术社区原创 > 聚合转载/采集站; 同一论点多来源冲突时, 以更高优先级来源为准
- 结果间存在事实冲突时, 不要静默选择一个——显式说明存在分歧及各方来源
- 采集站/转载站内容仅在没有更好来源时使用, 并在表述上降低其确定性
- 每个关键论点标注来源编号 [n]`

const RERANK_SNIPPET_MAX = 300

export function buildRerankPrompt(
  query: string,
  results: SearxngSearchResult[],
): string {
  const items = results
    .map((r, i) => {
      const title = (r.title ?? '').trim() || (r.url ?? '').trim()
      const snippet = (r.content ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, RERANK_SNIPPET_MAX)
      return `${i + 1}. ${title} — ${r.url ?? ''}\n   ${snippet}`
    })
    .join('\n')

  return `你是搜索结果筛选器。给定用户查询和一组搜索结果,逐条判断它对回答该查询的价值。

评判维度:
1. 相关性: 内容是否直接回应查询主题,还是文不对题/标题党
2. 可信度: 官方文档/一手资料 > 技术社区原创 > 聚合转载/采集站/软文营销

判 drop 的情形: 与查询无关、内容明显拼接堆砌、同域名同质内容的冗余副本、纯营销推广。
判 keep 的情形: 能实质帮助回答查询,即使是二手来源。

对每条输出 {"i": 序号, "v": "keep"或"drop", "r": "10字内理由"}。
只输出 JSON 数组,不要其他文字。

查询: ${query}

结果:
${items}`
}

type Verdict = { i?: unknown; v?: unknown }

/**
 * Parse the rerank model's verdict list. Throws on unparseable output —
 * callers fall back to the unfiltered result list.
 */
export function parseRerankVerdicts(text: string): Map<number, string> {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) {
    throw new Error('rerank output contained no JSON array')
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as Verdict[]
  if (!Array.isArray(parsed)) {
    throw new Error('rerank output was not an array')
  }
  const verdicts = new Map<number, string>()
  for (const entry of parsed) {
    if (typeof entry?.i === 'number' && typeof entry?.v === 'string') {
      verdicts.set(entry.i, entry.v)
    }
  }
  return verdicts
}

/** Items missing from the verdict map default to keep — prefer over-keeping. */
export function filterByVerdicts(
  results: SearxngSearchResult[],
  verdicts: Map<number, string>,
): SearxngSearchResult[] {
  return results.filter((_, index) => verdicts.get(index + 1) !== 'drop')
}
