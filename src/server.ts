import express from 'express';
import path from 'path';
import { createScanRoutes } from './routes/scan';
import { initializeOpenApiSpec } from './openapi/openapi-spec';
import { createLocalAccess } from './security/local-access';

const app = express();
const PORT = process.env.PORT || 3000;
const access = createLocalAccess();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});

// Middleware
app.use('/api/v2', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
}, express.json({ limit: Number.MAX_SAFE_INTEGER }));
app.use(express.static(path.join(__dirname, 'ui')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui', 'index.html'));
});

app.use('/api/v2', createScanRoutes(access));

// Error handling
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ message: 'Request body is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Request body must be valid JSON.' });
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

initializeOpenApiSpec().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
});
