/** stripDanglingPunct / endsDangling sanity tests. Run: npx tsx scripts/test_punct_helpers.ts */
import { stripDanglingPunct, endsDangling } from '../src/renderer/src/utils/punctHelpers'

let pass = 0
let fail = 0
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`FAIL  ${label}\n      actual:   ${a}\n      expected: ${e}`) }
}

// 用户案例：伪影句号拼接
eq(
  stripDanglingPunct('他就提出了要搞攀登计划，那么后来演变成。973计划。所以说这方面的基础研究。').text,
  '他就提出了要搞攀登计划，那么后来演变成973计划。所以说这方面的基础研究。',
  'user case: 演变成。973 → 拼接'
)

// 句尾标点保留（单元边界）
eq(stripDanglingPunct('当然。').text, '当然。', 'trailing punct kept')
eq(stripDanglingPunct('这件事当然。').text, '这件事当然。', 'trailing after dangling kept (boundary)')

// 多处命中
eq(
  stripDanglingPunct('也会起到重要的作用。当然。即使有重要作用呢。').stripped,
  ['当然'],
  'interior only: 当然。 hit, others kept'
)
eq(
  stripDanglingPunct('也会起到重要的作用。当然。即使有重要作用呢。').text,
  '也会起到重要的作用。当然即使有重要作用呢。',
  'multi: interior joined'
)

// 连续标点后不算正文
eq(stripDanglingPunct('然后。。他来了').text, '然后。。他来了', 'punct-follows-punct: no strip')

// 长词优先：演变成 不被 变成 截断
eq(stripDanglingPunct('后来演变成。973').stripped, ['演变成'], 'longest-first alternation')
eq(stripDanglingPunct('后来变成。973').stripped, ['变成'], 'shorter verb also matches')

// endsDangling
eq(endsDangling('并且。'), true, 'endsDangling 并且。')
eq(endsDangling('所以说。'), true, 'endsDangling 所以说。')
eq(endsDangling('这件事很重要。'), false, 'normal end not dangling')
eq(endsDangling('演变成。973计划。'), false, 'ends with real punct not dangling')

// 非悬垂句号不动
eq(
  stripDanglingPunct('我们对显微组织没有定量化分析。比如说我到了贝氏体钢。').text,
  '我们对显微组织没有定量化分析。比如说我到了贝氏体钢。',
  'normal sentences untouched'
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
