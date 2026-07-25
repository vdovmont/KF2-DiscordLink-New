const fs = require('fs');
const path = require('path');

const LOGS_DIR_PATH = path.resolve(__dirname, 'logs');
const LATEST_LOG_FILE_PATH = path.join(LOGS_DIR_PATH, 'latest.log');

const logSettings = {
  logFileRetentionDays: 7,
  toggleAllFileLogs: false,
  vote: false,
  kf2ReceiveBody: false,
  kf2Connection: false,
  steamFetch: false,
  steamCache: false,
  countryByIp: false,
};

let fileLoggingInitialized = false;
let fileLogRunSeparatorWritten = false;
let lastLogCleanupDate = '';

function formatLogTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}.${month}.${day} ${hours}:${minutes}:${seconds}`;
}

function formatLogFileDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function formatLogEntry(message, date = new Date()) {
  return `[${formatLogTimestamp(date)}] ${message}`;
}

function parseLogFileDate(fileName) {
  const match = String(fileName || '').match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const monthIndex = Number.parseInt(match[2], 10) - 1;
  const day = Number.parseInt(match[3], 10);
  const date = new Date(year, monthIndex, day);

  if (
    date.getFullYear() !== year
    || date.getMonth() !== monthIndex
    || date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function ensureLogDirectory() {
  fs.mkdirSync(LOGS_DIR_PATH, { recursive: true });
}

function cleanupOldLogFiles(now = new Date()) {
  if (logSettings.logFileRetentionDays <= 0) {
    return;
  }

  const todayKey = formatLogFileDate(now);
  if (lastLogCleanupDate === todayKey) {
    return;
  }

  ensureLogDirectory();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - (logSettings.logFileRetentionDays - 1));

  for (const entry of fs.readdirSync(LOGS_DIR_PATH, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const logDate = parseLogFileDate(entry.name);
    if (logDate && logDate < cutoff) {
      fs.unlinkSync(path.join(LOGS_DIR_PATH, entry.name));
    }
  }

  lastLogCleanupDate = todayKey;
}

function initializeFileLogging() {
  if (logSettings.logFileRetentionDays <= 0) {
    fileLoggingInitialized = false;
    fileLogRunSeparatorWritten = false;
    lastLogCleanupDate = '';
    return;
  }

  ensureLogDirectory();
  fs.writeFileSync(LATEST_LOG_FILE_PATH, '', 'utf8');
  fileLoggingInitialized = true;
  fileLogRunSeparatorWritten = false;
  cleanupOldLogFiles();
}

function writeConsole(level, entry) {
  console[level](entry);
}

function writeFiles(entry, now = new Date()) {
  if (logSettings.logFileRetentionDays <= 0) {
    return;
  }

  try {
    if (!fileLoggingInitialized) {
      initializeFileLogging();
    }

    cleanupOldLogFiles(now);
    const dailyLogFilePath = path.join(LOGS_DIR_PATH, `${formatLogFileDate(now)}.log`);
    const logLine = `${entry}\n`;
    const dailyLogLine = fileLogRunSeparatorWritten ? logLine : `\n${logLine}`;
    fs.appendFileSync(dailyLogFilePath, dailyLogLine, 'utf8');
    fs.appendFileSync(LATEST_LOG_FILE_PATH, logLine, 'utf8');
    fileLogRunSeparatorWritten = true;
  } catch (error) {
    writeConsole('error', formatLogEntry(`Failed to write log file: ${error.message || error}`));
  }
}

function writeLog(level, message, { consoleEnabled, fileEnabled }) {
  if (!consoleEnabled && !fileEnabled) {
    return;
  }

  const now = new Date();
  const entry = formatLogEntry(message, now);

  if (consoleEnabled) {
    writeConsole(level, entry);
  }
  if (fileEnabled) {
    writeFiles(entry, now);
  }
}

function logImportant(level, message) {
  writeLog(level, message, {
    consoleEnabled: true,
    fileEnabled: true,
  });
}

function logInfo(message) {
  logImportant('log', message);
}

function logWarn(message) {
  logImportant('warn', message);
}

function logError(message) {
  logImportant('error', message);
}

function logCategory(category, level, message) {
  const categoryEnabled = Boolean(logSettings[category]);

  writeLog(level, message, {
    consoleEnabled: categoryEnabled,
    fileEnabled: categoryEnabled || logSettings.toggleAllFileLogs,
  });
}

function logVoteInfo(message) {
  logCategory('vote', 'log', message);
}

function logVoteWarn(message) {
  logCategory('vote', 'warn', message);
}

function logVoteError(message) {
  logCategory('vote', 'error', message);
}

function logKf2ConnectionInfo(message) {
  logCategory('kf2Connection', 'log', message);
}

function logKf2ConnectionWarn(message) {
  logCategory('kf2Connection', 'warn', message);
}

function logReceivedKf2Body(config, payload) {
  logCategory(
    'kf2ReceiveBody',
    'log',
    `Received KF2 payload from "${config.name}":\n${String(payload || '').trim()}`,
  );
}

function logExampleResponseBody(commandName, payload) {
  logCategory(
    'kf2ReceiveBody',
    'log',
    `Received /example ${commandName} response payload:\n${String(payload || '').trim()}`,
  );
}

function logSteamFetch(message) {
  logCategory('steamFetch', 'log', message);
}

function logSteamCache(message) {
  logCategory('steamCache', 'log', message);
}

function logSteamCacheWarn(message) {
  logCategory('steamCache', 'warn', message);
}

function logCountryByIpPayload(direction, source, payload) {
  logCategory(
    'countryByIp',
    'log',
    `country_by_ip ${direction} (${source}):\n${JSON.stringify(payload)}`,
  );
}

function configureLogging(config = {}) {
  const previousRetentionDays = logSettings.logFileRetentionDays;
  const categorySettings = {
    vote: config.toggleVoteLogs,
    kf2ReceiveBody: config.toggleKf2ReceiveBodyLogs,
    kf2Connection: config.toggleKf2ConnectionLogs,
    steamFetch: config.toggleSteamFetchLogs,
    steamCache: config.toggleSteamCacheLogs,
    countryByIp: config.toggleCountryByIpLogs,
  };

  for (const [category, enabled] of Object.entries(categorySettings)) {
    if (typeof enabled === 'boolean') {
      logSettings[category] = enabled;
    }
  }

  if (typeof config.toggleAllFileLogs === 'boolean') {
    logSettings.toggleAllFileLogs = config.toggleAllFileLogs;
  }
  if (Number.isInteger(config.logFileRetentionDays) && config.logFileRetentionDays >= 0) {
    logSettings.logFileRetentionDays = config.logFileRetentionDays;
  }

  if (logSettings.logFileRetentionDays <= 0) {
    fileLoggingInitialized = false;
    fileLogRunSeparatorWritten = false;
    lastLogCleanupDate = '';
  } else if (!fileLoggingInitialized) {
    initializeFileLogging();
  } else if (previousRetentionDays !== logSettings.logFileRetentionDays) {
    lastLogCleanupDate = '';
    cleanupOldLogFiles();
  }
}

module.exports = {
  configureLogging,
  logCountryByIpPayload,
  logError,
  logExampleResponseBody,
  logInfo,
  logKf2ConnectionInfo,
  logKf2ConnectionWarn,
  logReceivedKf2Body,
  logSteamCache,
  logSteamCacheWarn,
  logSteamFetch,
  logVoteError,
  logVoteInfo,
  logVoteWarn,
  logWarn,
};
