const port = process.env.PORT ?? '8080';
const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
process.exit(res?.ok ? 0 : 1);
