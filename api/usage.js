// Anonymous usage + client error events. JSON-line stdout log; no IP, no UA, no PII.
export default function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const e = String(b.event ?? '').slice(0, 40);
      const line = { level: e === 'client_error' ? 'error' : 'info', scope: 'usage', event: e, ts: Date.now() };
      if (b.path) line.path = String(b.path).slice(0, 100);
      if (e === 'client_error') { line.err_scope = String(b.scope ?? '').slice(0, 40); line.msg = String(b.msg ?? '').slice(0, 200); }
      console.log(JSON.stringify(line));
    } catch {}
  }
  res.statusCode = 204; res.end();
}
