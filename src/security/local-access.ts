import { RequestHandler } from 'express';

export function createLocalAccess() {
  const sameOrigin: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.get('sec-fetch-site') === 'cross-site'
      || (req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`)) {
      res.status(403).json({ message: 'Cross-origin requests are not allowed.' });
      return;
    }
    next();
  };
  const authorize: RequestHandler = (_req, _res, next) => {
    next();
  };
  return { sameOrigin, authorize };
}