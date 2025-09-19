// Canonicalize Shoplazza shop hosts to single-z: *.myshoplazza.com
// - Accepts slug ("rg-demo") or host or full URL
// - Tolerates accidental ".myshoplazza.com" vs ".myshoplaza.com" (will normalize to single-z)
// - Returns null if shape is invalid
export function canonicalShopHost(input) {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase();

  // If a URL, extract hostname
  let host = raw;
  try {
    const u = new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`);
    host = u.hostname;
  } catch {
    // ignore
  }

  // If just a slug, add domain
  if (!host.includes('.')) host = `${host}.myshoplazza.com`;

  // Normalize any double-z (historical typos) → single-z
  host = host.replace('.myshoplazza.com', '.myshoplazza.com'); // no-op, kept for symmetry
  host = host.replace('.myshoplazza.com', '.myshoplazza.com'); // keep single-z final
  host = host.replace('.myshoplaza.com', '.myshoplazza.com'); // if someone passed single-z, keep single-z

  // The one we want is single-z: *.myshoplazza.com
  // If you truly want single-z, ensure it ends that way:
  host = host.replace('.myshoplaza.com', '.myshoplazza.com');

  // Basic validation
  if (!/^[a-z0-9-]+\.myshoplazza\.com$/i.test(host)) return null;

  return host;
}
