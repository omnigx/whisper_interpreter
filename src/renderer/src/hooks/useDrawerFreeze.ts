import { useLayoutEffect, useRef } from 'react'

/**
 * 抽屉"向下吞没"动画辅助。
 * 纯 CSS 的 0fr↔1fr 过渡里内容会随窗口双向压缩（输入框上滑、列表压扁），
 * 呈"向中间收缩"感。此钩子在展开态每次渲染持续记录窗口高度；收起瞬间把
 * 内容区高度冻结为该值并配合 self-end 底端锚定：内容不再压缩，窗口上缘
 * 向下扫过时从顶部逐行吞没。展开瞬间解除冻结，内容随窗口拉伸自然恢复。
 * 注：不能在收起提交时现读 offsetHeight——self-end 类同帧生效后 item 已
 * 塌缩为内容自然高度，冻结值会偏小。
 */
export function useDrawerFreeze(collapsed: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  const expandedHRef = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!collapsed) {
      expandedHRef.current = el.offsetHeight
      el.style.height = ''
    } else {
      el.style.height = `${expandedHRef.current}px`
    }
  }) // 无依赖：展开态每次渲染后记录，保证冻结值是收起前的展开高度
  return ref
}
