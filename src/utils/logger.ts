/**
 * Minimal structured logger. Emits single-line JSON with a `severity` field,
 * which Cloud Run (and most log collectors) parse into leveled log entries.
 */

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

function emit(severity: Severity, message: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({ severity, message, time: new Date().toISOString(), ...meta });
  if (severity === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>): void => emit('DEBUG', message, meta),
  info: (message: string, meta?: Record<string, unknown>): void => emit('INFO', message, meta),
  warn: (message: string, meta?: Record<string, unknown>): void => emit('WARNING', message, meta),
  error: (message: string, meta?: Record<string, unknown>): void => emit('ERROR', message, meta),
};
