import type { RequestHandler } from 'express';

/** Public app shell only; business data still uses the authenticated API. */
export function businessEntry(webRoot: string): RequestHandler {
  return (request, response, next) => {
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      (request.path !== '/contracts' && request.path !== '/opportunities')
    ) {
      next();
      return;
    }
    response.sendFile(
      'index.html',
      { root: webRoot, dotfiles: 'deny', cacheControl: false },
      (error) => {
        if (error) next(error);
      },
    );
  };
}
