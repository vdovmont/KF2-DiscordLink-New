const fs = require('fs');
const path = require('path');
const { logInfo, logWarn } = require('./logs');

const DATA_DIR_PATH = path.resolve(__dirname, 'data');
const USER_TOKENS_FILE_NAME = 'user_tokens.json';
const STEAM_USERS_FILE_NAME = 'steam_users.json';
const USER_TOKENS_FILE_PATH = path.join(DATA_DIR_PATH, USER_TOKENS_FILE_NAME);
const STEAM_USERS_FILE_PATH = path.join(DATA_DIR_PATH, STEAM_USERS_FILE_NAME);

function migrateLegacyDataFile(fileName, destinationPath) {
  const legacyPath = path.resolve(__dirname, fileName);
  if (!fs.existsSync(legacyPath)) {
    return;
  }

  if (fs.existsSync(destinationPath)) {
    logWarn(
      `Legacy data file ${legacyPath} was not moved because ${destinationPath} already exists.`,
    );
    return;
  }

  fs.renameSync(legacyPath, destinationPath);
  logInfo(`Moved runtime data file from ${legacyPath} to ${destinationPath}.`);
}

function initializeDataFiles() {
  fs.mkdirSync(DATA_DIR_PATH, { recursive: true });
  migrateLegacyDataFile(USER_TOKENS_FILE_NAME, USER_TOKENS_FILE_PATH);
  migrateLegacyDataFile(STEAM_USERS_FILE_NAME, STEAM_USERS_FILE_PATH);
}

module.exports = {
  DATA_DIR_PATH,
  STEAM_USERS_FILE_PATH,
  USER_TOKENS_FILE_PATH,
  initializeDataFiles,
};
