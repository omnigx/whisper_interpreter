import { app, BrowserWindow } from 'electron'
import {
  applyBackgroundKeepaliveSwitches,
  createMainWindow,
  registerWindowIpc,
  setupAppLifecycle
} from './windows'
import { registerSecureApiKeyIpc } from './secureApiKeys'
import { registerSessionIoIpc, registerSessionQuitGuard } from './sessionIO'
import { registerSttLauncher } from './sttLauncher'
import { registerAppConfigIpc } from './appConfig'

// Must run before app is ready
applyBackgroundKeepaliveSwitches()

// Single instance lock — focus existing window instead of silent quit
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    } else {
      createMainWindow()
    }
  })
  registerWindowIpc()
  registerSecureApiKeyIpc()
  registerAppConfigIpc()
  registerSessionIoIpc()
  registerSessionQuitGuard()
  registerSttLauncher()
  setupAppLifecycle()
}
