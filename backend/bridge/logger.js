// Structured logger for bridge server
// Usage: const log = require('./logger')('bridge');
//        log.info('Server started on port', 3333);
//        log.error('Connection failed:', err.message);
//
// Set LOG_FORMAT=json for JSON output (useful for log aggregation)
// Set LOG_LEVEL=debug|info|warn|error to filter (default: debug)

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const jsonFormat = process.env.LOG_FORMAT === 'json';
const minLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.debug;

function formatArgs(args) {
  return args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))).join(' ');
}

function createLogger(component) {
  const logger = {};

  for (const [level, priority] of Object.entries(LEVELS)) {
    logger[level] = (...args) => {
      if (priority < minLevel) return;

      const ts = new Date().toISOString();
      const msg = formatArgs(args);

      if (jsonFormat) {
        const entry = { ts, level, component, msg };
        const out = level === 'error' ? process.stderr : process.stdout;
        out.write(JSON.stringify(entry) + '\n');
      } else {
        const prefix = `${ts} [${component}]`;
        if (level === 'error') {
          console.error(prefix, msg);
        } else if (level === 'warn') {
          console.warn(prefix, msg);
        } else {
          console.log(prefix, msg);
        }
      }
    };
  }

  return logger;
}

module.exports = createLogger;
