import { lstatSync, readFileSync } from 'node:fs'

/**
 * Reads the token from a regular file that belongs to this OS user and that no group or other user may access.
 * @throws Error saying why the file cannot be used, never quoting its contents.
 */
export function readToken(file: string): string {
  let stat
  try { stat = lstatSync(file) } catch { throw new Error('it does not exist or cannot be read') }
  if (!stat.isFile()) throw new Error('it is not a regular file')
  if (stat.uid !== process.getuid?.()) throw new Error('it belongs to another user')
  if (stat.mode & 0o077) throw new Error('group or other users may access it; run chmod 600 on it')
  const token = readFileSync(file, 'utf8').trim()
  if (!/^\S+$/.test(token)) throw new Error('it holds no single token')
  return token
}
