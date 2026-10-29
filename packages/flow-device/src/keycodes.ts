/** Common Android `KeyEvent.KEYCODE_*` values, keyed by name without the prefix. */
export const KEYCODES: Readonly<Record<string, number>> = {
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_STOP: 86,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  VOLUME_MUTE: 164,
  APP_SWITCH: 187,
  BRIGHTNESS_DOWN: 220,
  BRIGHTNESS_UP: 221,
  SLEEP: 223,
  WAKEUP: 224,
  CUT: 277,
  COPY: 278,
  PASTE: 279,
}

const ALIASES: Readonly<Record<string, string>> = {
  BACKSPACE: 'DEL',
  DELETE: 'FORWARD_DEL',
  RECENTS: 'APP_SWITCH',
  RETURN: 'ENTER',
  UP: 'DPAD_UP',
  DOWN: 'DPAD_DOWN',
  LEFT: 'DPAD_LEFT',
  RIGHT: 'DPAD_RIGHT',
  MUTE: 'VOLUME_MUTE',
}

/** Accepts a number, a numeric string, `HOME`, `home` or `KEYCODE_HOME`. */
export function resolveKeyCode(key: number | string): number {
  if (typeof key === 'number') {
    if (Number.isInteger(key) && key >= 0)
      return key
    throw new RangeError(`Invalid key code: ${key}`)
  }
  const trimmed = key.trim()
  if (/^\d+$/.test(trimmed)) {
    const code = Number(trimmed)
    if (Number.isSafeInteger(code))
      return code
    throw new RangeError(`Invalid key code: ${key}`)
  }
  const name = trimmed.toUpperCase().replace(/^KEYCODE_/, '')
  const code = KEYCODES[ALIASES[name] ?? name]
  if (code === undefined)
    throw new RangeError(`Unknown key name: ${key}`)
  return code
}
