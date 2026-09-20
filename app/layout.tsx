import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'FFT 분석',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html className={`h-full antialiased`}>
      <body className='min-h-full flex flex-col'>
        {children}
        <footer>
          <a href='RTA'>RTA</a>
        </footer>
      </body>
    </html>
  )
}
