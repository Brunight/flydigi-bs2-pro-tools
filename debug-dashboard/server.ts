// Production server: serves the built client assets, everything else goes to TanStack Start.
// Run `bun run build` first, then `bun run start`.
const entry = new URL('./dist/server/server.js', import.meta.url)
if (!(await Bun.file(entry).exists())) throw new Error('No build found. Run `bun run build` first.')
const { default: handler } = (await import(entry.href)) as { default: { fetch: (req: Request) => Promise<Response> } }

const client = new URL('./dist/client/', import.meta.url)
const port = Number(process.env.PORT ?? 3000)
// Localhost only by default: anyone who can reach this page can control the cooler.
const hostname = process.env.HOST ?? 'localhost'

Bun.serve({
  port,
  hostname,
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname.startsWith('/assets/')) {
      const file = Bun.file(new URL(`.${pathname}`, client))
      if (await file.exists()) {
        return new Response(file, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } })
      }
    }
    return handler.fetch(req)
  },
})

console.log(`Flydigi cooler control on http://${hostname}:${port}`)
