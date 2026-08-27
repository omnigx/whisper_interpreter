import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      exclude: ['onnxruntime-web']
    },
    assetsInclude: ['**/*.onnx', '**/*.wasm'],
    // Soften CSP in dev so Vite HMR / wasm work; production HTML keeps its own meta CSP
    server: {
      headers: {
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: mediastream:; connect-src 'self' ws: wss: http: https:; font-src 'self' data:"
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          subtitle: resolve('src/renderer/subtitle.html')
        }
      }
    }
  }
})
