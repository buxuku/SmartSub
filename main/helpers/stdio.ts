/**
 * A desktop launcher can close its log pipe while SmartSub is still running.
 * Handle that stream's asynchronous EPIPE before any startup logging (#572).
 * Do not log here (stderr may be broken too), or suppress errors from other
 * streams / the process-wide uncaught exception handler.
 */
function onStdioError(error: NodeJS.ErrnoException): void {
  if (error.code !== 'EPIPE') throw error;
}

process.stdout.on('error', onStdioError);
process.stderr.on('error', onStdioError);

export {};
