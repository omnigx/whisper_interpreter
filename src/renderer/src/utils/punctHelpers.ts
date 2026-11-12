/**
 * 句中伪影句号清理。
 *
 * SenseVoice 按声学停顿打标点：气口处的句末标点常落在语义未完的位置
 * （"那么后来演变成。973计划"）。判据＝标点前紧邻悬垂词（连接词，或
 * 必须带宾语却还没带出的动词），且标点后仍有正文（句尾标点是翻译单元
 * 边界，保留不动）。命中即删标点拼接。
 */
export const DANGLING_WORDS = [
  '演变成', '所以说', // 3字优先
  '并且', '当然', '然后', '但是', '而且', '因为', '如果', '虽然',
  '就是', '还有', '或者', '同时', '接着', '于是', '以及', '变成',
  '形成', '称为', '叫做', '所以'
] as const

// 长词在前，防短词截断匹配（变成 吃掉 演变成）
const WORDS_ALT = [...DANGLING_WORDS].sort((a, b) => b.length - a.length).join('|')

/** 句中伪影：悬垂词 + 句末标点 + 后续正文 */
const INTERIOR_RE = new RegExp(`(${WORDS_ALT})[。！？!?](?=[^\\s。！？!?])`, 'g')

/** 句尾悬垂：悬垂词 + 句末标点收尾（标点切句的"暂不切"判据） */
const TRAILING_RE = new RegExp(`(?:${WORDS_ALT})[。！？!?]$`)

/** 去掉句中伪影句号；返回清理后文本与命中的悬垂词列表 */
export function stripDanglingPunct(text: string): { text: string; stripped: string[] } {
  const stripped: string[] = []
  const out = text.replace(INTERIOR_RE, (_m, word: string) => {
    stripped.push(word)
    return word
  })
  return { text: out, stripped }
}

/** 句尾是否以悬垂词+句末标点收尾（标点切句守卫用） */
export function endsDangling(text: string): boolean {
  return TRAILING_RE.test(text)
}
