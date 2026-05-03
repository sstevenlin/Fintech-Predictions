import { mkdirSync, createWriteStream, WriteStream } from 'fs';
import { dirname, join } from 'path';

let stream: WriteStream | null = null;

function isoNow(): string {
  return new Date().toISOString();
}

function format(args: unknown[]): string {
  return args
    .map(a => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
}

// Mirrors console.log / console.error / console.warn to a timestamped file.
// Returns the resolved log file path. Idempotent — calling twice is a no-op.
export function attachFileLogger(label: string, dir = 'logs'): string {
  if (stream) return (stream as any).path as string;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${label}-${ts}.log`);
  mkdirSync(dirname(file), { recursive: true });
  stream = createWriteStream(file, { flags: 'a' });

  const wrap = (level: 'log' | 'warn' | 'error', original: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      original(...args);
      stream!.write(`${isoNow()} ${level.toUpperCase()} ${format(args)}\n`);
    };

  console.log   = wrap('log',   console.log.bind(console));
  console.warn  = wrap('warn',  console.warn.bind(console));
  console.error = wrap('error', console.error.bind(console));

  process.on('uncaughtException', err => {
    console.error('[uncaughtException]', err);
  });
  process.on('unhandledRejection', err => {
    console.error('[unhandledRejection]', err);
  });

  console.log(`[logger] writing to ${file}`);
  return file;
}
