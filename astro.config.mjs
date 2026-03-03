import { defineConfig } from 'astro/config';
import AstroPWA from '@vite-pwa/astro';

// 開発モードかどうかの判定
const isDev = process.env.NODE_ENV !== 'production';

export default defineConfig({
  output: 'static',
  build: {
    assets: 'assets'
  },
  server: {
    port: 4321,
    host: true,
    // 🔴 開発中はヘッダーを空に、本番(preview)のみマルチスレッド用に有効化
    headers: !isDev ? {} : {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    }
  },
  vite: {
    envPrefix: 'PUBLIC_',
    optimizeDeps: {
      // 🔴 重要: 404エラー対策。ViteがONNX Runtimeを勝手に移動させないように除外
      exclude: ['onnxruntime-web']
    },
    build: {
      charset: 'utf8'
    },
    server: {
      // 🔴 server設定と同様に、開発中はヘッダーによるループを防止
      headers: !isDev ? {} : {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      // ★ ローカル開発用: vercel.json のリライトはVercel上でしか効かないため
      //    Vite dev serverで /api/v2/ と /socket.io/ をバックエンドにプロキシ
      proxy: isDev ? {
        '/api/v2': {
          target: process.env.PUBLIC_API_URL || 'http://localhost:8000',
          changeOrigin: true,
        },
        '/api/stt': {
          target: process.env.PUBLIC_API_URL || 'http://localhost:8000',
          changeOrigin: true,
        },
        '/socket.io': {
          target: process.env.PUBLIC_API_URL || 'http://localhost:8000',
          changeOrigin: true,
          ws: true,  // WebSocket対応
        },
      } : undefined,
    },
  },
  integrations: [
    AstroPWA({
      // 🔴 重要: 開発モードではPWAを無効化。これで無限リロードが物理的に止まります。
      disable: isDev,
      registerType: 'autoUpdate',
      manifestFilename: 'manifest.webmanifest',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Gourmet SP',
        short_name: 'Gourmet',
        description: '美味しいグルメを探すためのアプリ',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        // 🔴 iOS対策: SWがWASMやONNXをキャッシュしようとして壊れるのを防ぐ
        globIgnores: ['**/*.wasm', '**/*.onnx', '**/*ort-wasm*'],
        globPatterns: ['**/*.{css,js,html,svg,png,ico,txt}']
      }
    })
  ]
});