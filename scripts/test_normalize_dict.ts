/**
 * Standalone sanity test for normalizeDictJson (no test framework needed).
 * Run: npx tsx scripts/test_normalize_dict.ts
 */
import { normalizeDictJson, applySpeechDictFuzzy, MAX_DICT_ENTRIES } from '../src/renderer/src/utils/speechDict'

let pass = 0
let fail = 0
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`FAIL  ${label}\n      actual:   ${a}\n      expected: ${e}`) }
}

// 1. 对象格式：原词→纠正（既有 Niobium_test.json）
eq(
  normalizeDictJson({ 吸出: '析出', 固荣: '固溶' }),
  { 吸出: '析出', 固荣: '固溶' },
  'object pairs'
)

// 2. 对象格式：仅目标词（key=value 自映射，模糊模式用）
eq(
  normalizeDictJson({ 析出: '析出', 固溶: '固溶' }),
  { 析出: '析出', 固溶: '固溶' },
  'object self-map (target words only)'
)

// 3. 数组格式：仅目标词列表
eq(
  normalizeDictJson(['固溶', '析出', '铌元素']),
  { 固溶: '固溶', 析出: '析出', 铌元素: '铌元素' },
  'array of target words'
)

// 4. 混合格式：pair + self-map 共存
eq(
  normalizeDictJson({ 吸出: '析出', 固溶: '固溶', 泥元素: '铌元素' }),
  { 吸出: '析出', 固溶: '固溶', 泥元素: '铌元素' },
  'mixed object (pairs + self-map)'
)

// 5. 单字条目被过滤（模糊模式下单字会过度纠正）
eq(normalizeDictJson({ 铌: '铌', 吸出: '析出' }), { 吸出: '析出' }, 'single-char key filtered')
eq(normalizeDictJson(['铌']), {}, 'single-char array element filtered')

// 6. 非字符串条目跳过
eq(
  normalizeDictJson({ 固溶: 42, 奥实体: null, 吸出: '析出', 嵌套: { a: 1 } }),
  { 吸出: '析出' },
  'non-string values skipped'
)
eq(
  normalizeDictJson(['固溶', 42, null, { x: 1 }, '析出']),
  { 固溶: '固溶', 析出: '析出' },
  'non-string array elements skipped'
)

// 7. 空/空白条目跳过
eq(normalizeDictJson({ '  ': 'x', 固溶: '  ' }), {}, 'blank keys/values skipped')

// 8. 超长条目截断过滤
eq(normalizeDictJson({ ['a'.repeat(31)]: 'x' }), {}, 'over-length key filtered')
eq(normalizeDictJson({ ok: 'y'.repeat(31) }), {}, 'over-length value filtered')

// 9. 非法根类型
eq(normalizeDictJson('hello'), {}, 'string root rejected')
eq(normalizeDictJson(42), {}, 'number root rejected')
eq(normalizeDictJson(null), {}, 'null root rejected')
eq(normalizeDictJson(undefined), {}, 'undefined root rejected')
eq(normalizeDictJson(true), {}, 'boolean root rejected')

// 10. 条目数上限
const big: Record<string, string> = {}
for (let i = 0; i < 800; i++) big[`词组${String(i).padStart(3, '0')}`] = `目标${i}`
eq(Object.keys(normalizeDictJson(big)).length, MAX_DICT_ENTRIES, 'entry count capped at 500')

// 11. 原型污染键：JSON.parse 产生自有属性，normalizeDictJson 赋值时被原型 setter 忽略 → 条目丢弃、原型链不变
const protoJson = JSON.parse('{"__proto__": "x", "constructor": "y", "prototype": "z"}') as unknown
eq(normalizeDictJson(protoJson), {}, 'proto-ish keys dropped, no entries created')
const after = normalizeDictJson(protoJson)
eq(Object.getPrototypeOf(after) === Object.prototype, true, 'prototype chain untouched')

// 12. 端到端：fuzzy 模式下 target-word 条目纠正同音错字（直接调用生产函数，
//     防止手写循环复现逻辑而掩盖生产 bug——2026-11-12 整句丢失事故的教训）
{
  const dict = normalizeDictJson(['固溶', '析出', '铌元素'])
  const r1 = applySpeechDictFuzzy('这种合金的固荣处理让碳化物吸出', dict)
  eq(r1.text, '这种合金的固溶处理让碳化物析出', 'fuzzy e2e: target-word dict corrects homophones')
  const r2 = applySpeechDictFuzzy('这种合金的固荣处理让泥元素含量上升', { 固荣: '固溶', 泥元素: '铌元素' })
  eq(r2.text, '这种合金的固溶处理让铌元素含量上升', 'fuzzy e2e: full sentence preserved with replacements')
  eq(r2.corrections.length, 2, 'fuzzy e2e: both corrections reported')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
