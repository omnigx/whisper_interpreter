import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './components/AppShell'
import { DisplayRoot } from './components/DisplayRoot'
import { initTheme } from './utils/theme'
import './styles/globals.css'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DisplayRoot>
      <AppShell />
    </DisplayRoot>
  </StrictMode>
)
