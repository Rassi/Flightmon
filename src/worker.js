// Cloudflare Worker. Static files in public/ are served by Workers Assets
// before this runs, so the Worker only sees /api/* and unknown paths.
// Workers treat every named export of this module as an entrypoint, so the
// rest lives in api.js.

import { getAircraft, json } from './api.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/aircraft') return json({ error: 'Not found' }, 404);
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return getAircraft(url);
  },
};
