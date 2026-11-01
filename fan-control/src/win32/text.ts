// Win32 takes UTF-16 strings, NUL-terminated.
export const wide = (text: string) => Buffer.from(`${text}\0`, 'utf16le')
