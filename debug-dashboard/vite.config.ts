import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Native Bluetooth addon: load it from node_modules at runtime instead of bundling it.
  ssr: { external: ['webbluetooth'] },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
