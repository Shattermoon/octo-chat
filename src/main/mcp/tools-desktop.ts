/** Native Desktop is a Windows-only product surface. */
import type { SurfaceRegistrar } from './kernel.js';
import { registerWindowsDesktopTools } from './tools-desktop-windows.js';

export function registerDesktopTools(reg: SurfaceRegistrar): void {
  if (process.platform === 'win32') registerWindowsDesktopTools(reg);
}
