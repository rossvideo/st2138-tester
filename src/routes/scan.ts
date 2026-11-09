import { Router, Request, Response } from 'express';
import { createLocalAccess } from '../security/local-access';
import { runOperation } from '../security/run-operation';
import type { OperationMessage } from '../security/operation-worker';
import { normalizeDeviceJwt } from '../security/device-transport';

export function createScanRoutes(access: ReturnType<typeof createLocalAccess>) {
  const router = Router();
  router.use(access.sameOrigin);
  const execute = (operation: OperationMessage['operation']) => (req: Request, res: Response) => {
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.url !== 'string' || !input.url.trim() || input.url.length > 2048) {
      res.status(400).json({ message: 'A valid device URL is required.' });
      return;
    }
    if (input.allowInsecureTls !== undefined && typeof input.allowInsecureTls !== 'boolean') {
      res.status(400).json({ message: 'Allow insecure TLS must be a boolean.' });
      return;
    }
    try {
      input.jwt = normalizeDeviceJwt(input.jwt);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid device JWT.' });
      return;
    }
    if (operation === 'command' || operation === 'endpoint') {
      if (!['rest', 'grpc'].includes(input.protocol)
        || (input.slot !== null && input.slot !== undefined && (!Number.isSafeInteger(input.slot) || input.slot < 0))) {
        res.status(400).json({ message: 'A valid protocol and slot are required.' });
        return;
      }
    }
    if (operation === 'command' && (!Number.isSafeInteger(input.slot)
      || typeof input.oid !== 'string' || !input.oid.trim() || input.oid.length > 2048)) {
      res.status(400).json({ message: 'A command slot and OID are required.' });
      return;
    }
    if (operation === 'endpoint' && (typeof input.method !== 'string' || !input.method.trim() || input.method.length > 64
      || typeof input.endpoint !== 'string' || !input.endpoint.trim() || input.endpoint.length > 4096)) {
      res.status(400).json({ message: 'A valid endpoint and method are required.' });
      return;
    }
    access.authorize(req, res, () => { void runOperation(req, res, operation); });
  };
  router.post('/scan/rest', execute('rest'));
  router.post('/scan/grpc', execute('grpc'));
  router.post('/command', execute('command'));
  router.post('/endpoint/run', execute('endpoint'));
  return router;
}