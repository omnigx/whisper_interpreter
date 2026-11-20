/**
 * AudioWorklet 模块 URL 解析。
 *
 * Chromium 的 audioWorklet.addModule 无法从 asar 归档内加载模块（其 fetch
 * 不经过 Electron 的 asar 虚拟文件系统）——打包后 file:// 指进 asar 即抛
 * "Unable to load a worklet's module"。对策＝electron-builder asarUnpack
 * 把 worklet 文件解包到 resources/app.asar.unpacked/，此处把 URL 改指该
 * 真实目录；dev（http）维持站点根路径。
 */

/** path 为站点根相对（dev 下 public 根 = out/renderer 根），如 '/pcm-capture-processor.js' */
export function workletModuleUrl(path: string): string {
  if (window.location.protocol !== 'file:') {
    return new URL(path, window.location.origin).href
  }
  // 打包页位于 <resources>/app.asar/out/renderer/index.html
  const i = window.location.href.indexOf('/app.asar/')
  if (i < 0) return new URL(path, window.location.origin).href
  return `${window.location.href.slice(0, i)}/app.asar.unpacked/out/renderer${path}`
}
