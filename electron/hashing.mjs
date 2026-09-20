/**
 * One non-cryptographic hash, shared.
 *
 * Two modules needed the same 32-bit FNV-1a — experiment arm assignment and
 * migration body fingerprints — and two copies of a hash is one copy too many:
 * the moment they drift, a bucketing or a fingerprint silently changes meaning
 * without anything failing. It lives here so both processes and the browser
 * demo get the identical function, and so it stays Node-free.
 *
 * This is deliberately *not* a cryptographic digest. Nothing here is a security
 * boundary; the values are only ever compared with each other.
 */
export function hash32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
