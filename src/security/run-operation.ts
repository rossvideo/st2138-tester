import { fork } from 'child_process';
import path from 'path';
import { Request, Response } from 'express';
import { getOpenApiSpec } from '../openapi/openapi-spec';
import type { OperationMessage } from './operation-worker';

const PROGRESS_HEARTBEAT_MS = 5000;
const IDLE_TIMEOUT_MS = Number(process.env.OPERATION_IDLE_TIMEOUT_MS) || 300000;

export async function runOperation(req: Request, res: Response,
  operation: OperationMessage['operation']): Promise<void> {
  let worker: ReturnType<typeof fork> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const streamsProgress = operation === 'rest' || operation === 'grpc';
  const startedAt = Date.now();
  let terminated = false;
  let latestProgress: string | undefined;
  const writeProgress = (message: string) => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) {
      res.status(200).type('application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }
    res.write(`${JSON.stringify({ type: 'progress', message })}\n`);
  };
  const stop = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    if (terminated) return;
    terminated = true;
    if (worker) worker.kill('SIGKILL');
  };
  const disconnected = () => { if (!res.writableEnded) stop(); };
  res.once('close', disconnected);
  try {
    const spec = operation === 'rest' ? await getOpenApiSpec() : undefined;
    if (res.destroyed) return;
    const extension = path.extname(__filename);
    worker = fork(path.join(__dirname, `operation-worker${extension}`), [], {
      execArgv: extension === '.ts' ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV,
        ST2138_SUBMODULE_ROOT: process.env.ST2138_SUBMODULE_ROOT }
    });
    if (streamsProgress) {
      heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        writeProgress(`${latestProgress ?? 'Checking populated device slots…'} (${elapsed}s elapsed)`);
      }, PROGRESS_HEARTBEAT_MS);
    }
    const onIdle = () => {
      const message = `No progress from the device operation for ${Math.round(IDLE_TIMEOUT_MS / 1000)} seconds. Device values may need manual verification.${latestProgress ? ` Last reported step: ${latestProgress}` : ''}`;
      if (!res.destroyed) {
        if (res.headersSent) {
          res.write(`${JSON.stringify({ type: 'error', message, code: 'operation_timeout' })}\n`);
          res.end();
        } else res.status(504).json({ message });
      }
      stop();
    };
    timer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
    await new Promise<void>((resolve, reject) => {
      let result: { result?: unknown; error?: string; code?: string } | undefined;
      worker!.once('error', reject);
      worker!.on('message', (message: { type?: string; message?: string; result?: unknown; error?: string; code?: string }) => {
        if (message.type === 'progress' && streamsProgress) {
          latestProgress = message.message;
          timer?.refresh();
          writeProgress(message.message ?? '');
          return;
        }
        result = message;
      });
      worker!.once('exit', () => {
        if (heartbeat) clearInterval(heartbeat);
        if (!res.destroyed && !res.writableEnded && !res.headersSent) {
          if (result?.error) res.status(result.code === 'jwt_required' ? 401 : 502).json({
            ...(result.code ? { code: result.code } : {}), message: result.error
          });
          else if (result) res.json(result.result);
          else res.status(502).json({ message: 'Device worker stopped unexpectedly. Device values may need manual verification.' });
        } else if (!res.destroyed && !res.writableEnded && res.headersSent && streamsProgress) {
          if (result?.error) {
            res.write(`${JSON.stringify({ type: 'error', message: result.error, ...(result.code ? { code: result.code } : {}) })}\n`);
          } else if (result) {
            res.write(`${JSON.stringify({ type: 'result', result: result.result })}\n`);
          } else {
            res.write(`${JSON.stringify({ type: 'error', message: 'Device worker stopped unexpectedly. Device values may need manual verification.' })}\n`);
          }
          res.end();
        }
        resolve();
      });
      worker!.send({ operation, input: req.body, spec });
    });
  } catch {
    if (!res.destroyed && !res.writableEnded) {
      const message = 'Unable to start the device operation. Please try later.';
      if (res.headersSent && streamsProgress) {
        res.write(`${JSON.stringify({ type: 'error', message })}\n`);
        res.end();
      } else if (!res.headersSent) res.status(503).json({ message });
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    stop();
    res.off('close', disconnected);
  }
}