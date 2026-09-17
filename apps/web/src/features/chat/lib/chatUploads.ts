// Chat attachments (Track 11), browser half. The upload is plain REST multipart, NOT tRPC: tRPC
// speaks JSON, and base64-ing a 25 MB video through it would cost a third more bytes and a full
// copy in memory on both ends.
//
// Two things differ from the mobile client, both because this is a COOKIE session rather than a
// bearer token:
//   1. `x-box-csrf` is REQUIRED. Bearer auth is CSRF-exempt; cookie auth is not, and without the
//      header the server refuses the upload.
//   2. `credentials: 'same-origin'` has to be explicit for the cookie to ride along.
import type { ChatAttachment } from './chatTypes.ts'

/** Where an attachment's bytes live. Same-origin, so the session cookie rides along on an <img>
 *  or a download link with no extra work - and the server re-authorizes on EVERY request, so a
 *  URL that leaks is not a capability. */
export function attachmentUrl(id: string): string {
  return `/api/chat/attachments/${encodeURIComponent(id)}`
}

/**
 * Whether a clipboard/drag payload should be treated as FILES TO ATTACH, judged from its `types`
 * alone (during `dragover` the browser withholds `files`, so types is all there is).
 *
 * The rule: files are an attach ONLY when the payload carries no usable text. Several everyday
 * payloads carry both, and in every one of them the text is what the person meant -
 * Excel/Sheets put an HTML table AND a PNG rendition of it on the clipboard, Finder and VS Code
 * put a filename or path alongside the file. Uploading in those cases produces a mystery image
 * next to the text you actually wanted.
 */
export function isAttachIntent(types: readonly string[]): boolean {
  if (!types.includes('Files')) return false
  return !types.includes('text/plain') && !types.includes('text/html')
}

/** The files to upload from a paste or drop, empty when the payload is really text. */
export function filesToAttach(data: DataTransfer | null): File[] {
  if (data === null || !isAttachIntent(data.types)) return []
  return [...data.files]
}

/** Human size, binary units - matches the mobile client's `sizeLabel`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The extensions browsers routinely hand over with an EMPTY or useless `type`, mapped to what the
 * server's allowlist actually names them.
 *
 * A `File` from a drop or a picker carries whatever the OS told the browser, and for the plain-text
 * shapes this team trades most (logs, markdown, csv exports) that is frequently `''`. An empty type
 * reaches the server as `application/octet-stream` and comes back as "not an accepted attachment
 * type" for a file the allowlist explicitly accepts - a confusing refusal with no way for the
 * person to act on it. Same reasoning as `mimeForFilename` in the Flutter client.
 */
const EXTENSION_MIME: Record<string, string> = {
  heic: 'image/heic',
  heif: 'image/heic',
  md: 'text/markdown',
  markdown: 'text/markdown',
  log: 'text/plain',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
  gz: 'application/gzip',
  pdf: 'application/pdf',
}

/**
 * The MIME to declare for `file`. EXTENSION FIRST for the extensions above, exactly like the
 * Flutter client's `mimeForFilename`.
 *
 * Extension-first rather than browser-first because the browser's answer is derived from the OS
 * file association, which is routinely wrong in a way the allowlist punishes: a Windows box with
 * Excel installed reports `.csv` as `application/vnd.ms-excel`, which is specific, plausible, and
 * gets a verbatim 415 for a file the server explicitly accepts as `text/csv`. The map only covers
 * extensions whose correct type is unambiguous, so preferring it costs nothing.
 */
export function mimeForFile(file: File): string {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  const known = EXTENSION_MIME[ext]
  if (known !== undefined) return known
  const reported = file.type.split(';')[0].trim().toLowerCase()
  if (reported !== '' && reported !== 'application/octet-stream') return reported
  return 'application/octet-stream'
}

/**
 * Upload one file and get back the ORPHAN attachment - it belongs to nobody's message until a post
 * claims its id, and is swept after 24h if no post ever does. So abandoning a draft costs nothing.
 */
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<ChatAttachment> {
  const mime = mimeForFile(file)
  // Re-wrap only when we actually disagree with the browser, so the common case sends the original
  // File untouched. The multipart part's Content-Type comes from the Blob's `type`.
  const payload = mime === file.type ? file : new File([file], file.name, { type: mime })

  const form = new FormData()
  // The field name is the contract with the server's FileInterceptor('file').
  form.append('file', payload, file.name)

  const res = await fetch('/api/chat/attachments', {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
    // Deliberately NOT setting content-type: the browser must generate the multipart boundary
    // itself, and naming the type by hand omits it and makes the body unparseable.
    headers: { 'x-box-csrf': '1' },
    signal,
  })

  if (!res.ok) throw new Error(await refusal(res))
  return (await res.json()) as ChatAttachment
}

/**
 * The server's refusals are VERBATIM by design (the 25 MB cap, the MIME allowlist), and they are
 * the only thing that tells a person why their file bounced - so surface the message rather than
 * flattening it to "upload failed".
 */
async function refusal(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const message = (body as { message: unknown }).message
      if (Array.isArray(message)) return message.join(', ')
      if (typeof message === 'string' && message !== '') return message
    }
  } catch {
    // Not JSON (a proxy error page, an empty 413). Fall through to the status line.
  }
  return `upload failed (${res.status})`
}
