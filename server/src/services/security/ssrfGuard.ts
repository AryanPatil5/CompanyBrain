// ssrGuard.ts
export function ssrfGuard(req: any, res: any, next: any) {
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  if (!userAgent.includes('company-brain')) {
    return res.status(400).json({ error: 'Invalid User-Agent for SSRF requests' });
  }
  const url = new URL(req.body?.url || req.query?.url || '');
  const allowedHosts = (process.env.SSRF_ALLOWED_HOSTS || '').split(',').filter(Boolean);
  if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname)) {
    return res.status(400).json({ error: 'Host not in allowed SSRF list' });
  }
  const urlHostname = url.hostname;
  const urlHost = urlHostname.includes('.') ? urlHostname : `${urlHostname}.internal`;
  if (/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(urlHost)) {
    return res.status(400).json({ error: 'SSRF: IP addresses in URLs are not allowed' });
  }
  next();
}