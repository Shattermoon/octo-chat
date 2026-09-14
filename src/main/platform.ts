import { DESKTOP_CAPABILITIES, type Capabilities, type PlatformInfo } from '../shared/types.js';

export function desktopAutomationSupported(
  platform: NodeJS.Platform = process.platform,
  _release?: string
): boolean {
  return platform === 'win32';
}

export function hostPlatformInfo(
  platform: NodeJS.Platform = process.platform,
  release?: string
): PlatformInfo {
  if (platform === 'win32') return { family: 'windows', name: 'Windows', desktopAutomation: true };
  if (platform === 'darwin') {
    return { family: 'macos', name: 'macOS', desktopAutomation: desktopAutomationSupported(platform, release) };
  }
  if (platform === 'linux') return { family: 'linux', name: 'Linux', desktopAutomation: false };
  return { family: 'other', name: platform, desktopAutomation: false };
}

/**
 * Windows is the only currently supported native Desktop backend. Keep stored choices intact so
 * a config moved back to Windows does not lose them, but make the live capability projection
 * incapable of advertising or executing those tools on unsupported hosts.
 */
export function capabilitiesForPlatform(
  capabilities: Capabilities,
  platform: NodeJS.Platform = process.platform,
  release?: string
): Capabilities {
  if (desktopAutomationSupported(platform, release)) return capabilities;
  const next = { ...capabilities };
  for (const capability of DESKTOP_CAPABILITIES) next[capability] = false;
  return next;
}
