import path from 'node:path';

/**
 * Linux window managers do not reliably recover the application icon from AppImage metadata
 * when the raw AppImage is launched directly. Give packaged Linux windows an explicit branded
 * PNG, while Windows keeps the executable icon chosen by the native platform.
 */
export function browserWindowIconPath(
  platform: NodeJS.Platform,
  packaged: boolean,
  resourcesPath: string
): string | undefined {
  if (platform !== 'linux' || !packaged) return undefined;
  return path.join(resourcesPath, 'runtime-icon.png');
}
