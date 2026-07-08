'use strict';

function firstHeaderValue(value) {
  return String(value || '').split(',')[0].trim().toLowerCase();
}

function decodedVariants(value) {
  const variants = [String(value || '')];
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(variants.at(-1));
      if (decoded === variants.at(-1)) break;
      variants.push(decoded);
    } catch { break; }
  }
  return variants;
}

function urlCandidates(value) {
  const candidates = [];
  for (const variant of decodedVariants(value)) {
    for (const match of variant.matchAll(/https?:\/\/[^\s,;"'<>]+/gi)) {
      try { candidates.push(new URL(match[0])); } catch { /* try the next proxy value */ }
    }
  }
  return candidates;
}

function allowedHosts(req, appBaseUrl) {
  const hosts = new Set();
  for (const value of [req.get('host'), firstHeaderValue(req.get('x-forwarded-host'))]) {
    if (value) hosts.add(String(value).trim().toLowerCase());
  }
  if (appBaseUrl) {
    try { hosts.add(new URL(String(appBaseUrl).trim()).host.toLowerCase()); } catch { /* ignore bad configuration */ }
  }
  return hosts;
}

function requestOriginGuard({ appBaseUrl = process.env.APP_BASE_URL, production = process.env.NODE_ENV === 'production' } = {}) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path.startsWith('/tasks/')) return next();

    const fetchSite = String(req.get('sec-fetch-site') || '').trim().toLowerCase();
    if (fetchSite === 'cross-site') return res.status(403).send('Cross-site request blocked');

    const source = req.get('origin') || req.get('referer');
    if (!source) return next();
    if (String(source).trim() === 'null' && !production) return next();

    const candidates = urlCandidates(source);
    const hosts = allowedHosts(req, appBaseUrl);
    if (candidates.some(candidate => ['http:', 'https:'].includes(candidate.protocol) && hosts.has(candidate.host.toLowerCase()))) return next();

    // Some managed proxies encode or wrap Origin beyond recognition. Modern
    // browsers still provide Sec-Fetch-Site, which the browser prevents page
    // scripts from forging. Only the strict same-origin value is a safe fallback.
    if (!candidates.length && fetchSite === 'same-origin') return next();
    return res.status(403).send(candidates.length ? 'Cross-site request blocked' : 'Invalid request origin');
  };
}

module.exports = { requestOriginGuard, urlCandidates };
