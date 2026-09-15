/** Only the process that owns Electron's single-instance lock owns app runtime state/teardown. */
export function ownsAppRuntime(hasSingleInstanceLock: boolean): boolean {
  return hasSingleInstanceLock;
}

/**
 * Whether this process is allowed to touch the shared userData bootstrap at all.
 *
 * A losing single-instance process still evaluates this module and its `whenReady()` callback
 * can race `app.quit()`. Likewise the primary can receive an OS/application quit before ready.
 * Both are terminal: config/secrets/session/durable initialization belongs only to the live lock
 * owner, never to a process already leaving.
 */
export function shouldBeginAppBootstrap(hasSingleInstanceLock: boolean, quitting: boolean): boolean {
  return ownsAppRuntime(hasSingleInstanceLock) && !quitting;
}

/**
 * `second-instance` is only guaranteed to happen after Electron's `ready` event. Our own startup
 * continues well past that while config/durable state is restored and, critically, before the
 * renderer CSP/permission handlers and IPC surface are installed. Keep an early re-launch from
 * constructing a BrowserWindow across that gap. The normal startup path opens the initial window
 * once the gate is enabled, so dropping an earlier focus request loses nothing; later requests
 * focus/recreate the window immediately.
 */
export function createWindowActivationGate(showWindow: () => void): {
  request: () => void;
  enable: () => void;
  disable: () => void;
  isDisabled: () => boolean;
} {
  let enabled = false;
  // Shutdown is a terminal lifetime boundary, not a temporary pause. A startup continuation
  // can resume after `before-quit` because the main bootstrap contains several awaits; letting
  // that stale continuation call enable() again would reopen native activation during teardown.
  let disabled = false;
  return {
    request: () => {
      if (enabled && !disabled) showWindow();
    },
    enable: () => {
      if (!disabled) enabled = true;
    },
    disable: () => {
      disabled = true;
      enabled = false;
    },
    isDisabled: () => disabled
  };
}

/** When close-to-tray is off, closing the last window exits the supported app runtime. */
export function shouldQuitOnWindowAllClosed(
  _platform: NodeJS.Platform,
  minimizeToTray: boolean
): boolean {
  return !minimizeToTray;
}

/** Login launch is distinct from tunnel auto-connect and ordinary app activation. */
export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.includes('--background');
}

export function supportsLoginStartup(platform: NodeJS.Platform, packaged: boolean): boolean {
  return platform === 'win32' && packaged;
}

export function applyLoginStartup(
  app: { isPackaged: boolean; setLoginItemSettings(settings: { openAtLogin: boolean; path: string; args: string[] }): void },
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
  executable = process.execPath
): void {
  if (!supportsLoginStartup(platform, app.isPackaged)) return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: executable, args: ['--background'] });
}
