import { useLayoutEffect, useRef } from 'react'

/**
 * 抽屉"吞没/显现"动画辅助。
 * 纯 CSS 的 0fr↔1fr 过渡里内容会随窗口双向压缩（输入框上滑、列表压扁），
 * 呈"向中间收缩/展开"感。此钩子让内容在收起与展开过渡期间都保持冻结高度
 * 并底端锚定（align-self: end 由内联样式管理，不随 collapsed 类即时脱落）：
 * - 收起：窗口上缘下扫，内容从顶部逐行被吞没（输入框最后消失）
 * - 展开：窗口上缘上扫，静止的内容从顶部逐行显现（输入框最先出现）——收起的镜像
 * - 过渡结束后解除冻结（此刻窗口=冻结高度，盒模型一致，无跳变）
 * 冻结值取展开态每次渲染持续记录的窗口高度，而非切换时现读
 * （self-end 同帧生效后元素已塌缩为内容自然高度，现读会偏小）。
 */
export function useDrawerFreeze(collapsed: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  const expandedHRef = useRef(0)
  const cleanupTimer = useRef(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    window.clearTimeout(cleanupTimer.current)
    if (!collapsed) {
      expandedHRef.current = el.offsetHeight
      if (el.style.height) {
        // 刚从收起切换到展开：保持冻结至过渡结束（duration-200 + 余量）
        cleanupTimer.current = window.setTimeout(() => {
          el.style.height = ''
          el.style.alignSelf = ''
        }, 240)
      }
    } else {
      el.style.height = `${expandedHRef.current}px`
      el.style.alignSelf = 'end'
    }
  }) // 无依赖：展开态每次渲染后记录，保证冻结值是切换前的展开高度
  return ref
}
