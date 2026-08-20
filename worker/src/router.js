// ===================================================================
// یک روتر بسیار سبک (بدون کتابخانه خارجی) برای Cloudflare Workers
// ===================================================================
export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    // pattern مثل /api/offers/:id یا /files/:key* (ستاره = شامل / هم می‌شود) را به regex تبدیل می‌کند
    const paramNames = [];
    const regexStr = pattern.replace(/\/:([^/]+)/g, (_, name) => {
      if (name.endsWith('*')) {
        paramNames.push(name.slice(0, -1));
        return '/(.+)';
      }
      paramNames.push(name);
      return '/([^/]+)';
    });
    const regex = new RegExp(`^${regexStr}$`);
    this.routes.push({ method, regex, paramNames, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  del(p, h) { this.add('DELETE', p, h); }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Setup-Key',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        },
      });
    }
    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const m = url.pathname.match(route.regex);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      return route.handler({ request, env, ctx, url, params });
    }
    return new Response(JSON.stringify({ error: 'یافت نشد' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
