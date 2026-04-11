class HttpClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  captureSetCookie(headers) {
    let values = [];
    if (headers && typeof headers.getSetCookie === 'function') {
      values = headers.getSetCookie();
    } else if (headers && typeof headers.get === 'function') {
      const raw = headers.get('set-cookie');
      if (raw) values = [raw];
    }
    values.forEach((value) => {
      const first = String(value || '').split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) return;
      const name = first.slice(0, eq).trim();
      const cookieValue = first.slice(eq + 1).trim();
      if (!name) return;
      if (!cookieValue) {
        this.cookies.delete(name);
        return;
      }
      this.cookies.set(name, cookieValue);
    });
  }

  async request(method, path, body) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = { 'Content-Type': 'application/json' };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, {
      method: String(method || 'GET').toUpperCase(),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.captureSetCookie(res.headers);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, ok: res.ok, body: data };
  }
}

module.exports = { HttpClient };
