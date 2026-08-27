import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './components/AppShell'
import { DisplayRoot } from './components/DisplayRoot'
import './styles/globals.css'

/** Legacy subtitle.html entry — redirect into hash route of the shared app. */
if (!window.location.hash.includes('subtitle')) {
  window.location.hash = '/subtitle'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DisplayRoot>
      <AppShell />
    </DisplayRoot>
  </StrictMode>
)
