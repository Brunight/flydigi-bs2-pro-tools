import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Flydigi Cooler' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-slate-950">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
