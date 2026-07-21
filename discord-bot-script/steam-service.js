const fs = require('fs');

const DEFAULT_RETENTION_DAYS = 30;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function getLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isSameLocalDay(timestamp, date) {
  if (!timestamp) {
    return false;
  }

  const parsedDate = new Date(timestamp);
  return !Number.isNaN(parsedDate.getTime()) && getLocalDateKey(parsedDate) === getLocalDateKey(date);
}

function normalizeCacheRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const steamId = String(record.steamId || record.steamid || '').trim();
  if (!steamId) {
    return null;
  }

  return {
    steamId,
    vanityName: String(record.vanityName || ''),
    nickname: String(record.nickname || ''),
    avatarUrl: String(record.avatarUrl || ''),
    lastFetchedAt: String(record.lastFetchedAt || ''),
  };
}

class SteamService {
  constructor({
    apiKey = '',
    cacheFilePath,
    retentionDays = DEFAULT_RETENTION_DAYS,
    logInfo = () => {},
    logWarn = () => {},
    now = () => new Date(),
  }) {
    this.activeApiKey = apiKey;
    this.cacheFilePath = cacheFilePath;
    this.retentionDays = retentionDays;
    this.logInfo = logInfo;
    this.logWarn = logWarn;
    this.now = now;
    this.users = new Map();
    this.pendingRefreshes = new Map();
    this.pendingVanityResolutions = new Map();
    this.lastCleanupDate = '';
    this.cleanupTimer = null;
  }

  initialize() {
    this.loadCache();
    this.cleanupExpiredUsersSafely();
    this.scheduleDailyCleanup();
  }

  setRetentionDays(retentionDays) {
    this.retentionDays = retentionDays;
    this.lastCleanupDate = '';
    this.cleanupExpiredUsersSafely();
  }

  normalizeSteamId(rawSteamId) {
    const value = String(rawSteamId || '').trim();
    if (!value) {
      return '';
    }

    try {
      if (/^[+-]?0x[0-9a-f]+$/i.test(value) || /^[+-]?\d+$/.test(value)) {
        return BigInt(value).toString(10);
      }
    } catch (error) {
      this.logWarn(`Could not normalize SteamID "${value}": ${error.message || error}`);
    }

    return value;
  }

  isValidSteamId64(steamId) {
    if (typeof steamId !== 'string') {
      return false;
    }

    const trimmedSteamId = steamId.trim();
    if (!/^\d{17}$/.test(trimmedSteamId)) {
      return false;
    }

    try {
      const value = BigInt(trimmedSteamId);
      return value >= 76561197960265728n && value <= 99999999999999999n;
    } catch (error) {
      return false;
    }
  }

  async resolveChatUser(steamId, fallbackUsername) {
    if (!steamId || !this.isValidSteamId64(steamId)) {
      return { username: fallbackUsername, avatarUrl: '' };
    }

    try {
      const player = await this.getPlayerSummary(steamId);
      return {
        username: player?.personaname || fallbackUsername,
        avatarUrl: player?.avatar || '',
      };
    } catch (error) {
      this.logWarn(`Could not retrieve Steam information for ${fallbackUsername} (${steamId}): ${error.message || error}`);
      return { username: fallbackUsername, avatarUrl: '' };
    }
  }

  async resolveResponseTargetDisplay(target, displayCache = new Map()) {
    const normalizedTarget = String(target || '').trim();
    if (!normalizedTarget) {
      return '';
    }

    if (this.isValidSteamId64(normalizedTarget)) {
      return this.resolveSteamIdDisplayName(normalizedTarget, displayCache);
    }

    return normalizedTarget;
  }

  async resolveSteamIdDisplayName(steamId, displayCache = new Map()) {
    const normalizedSteamId = String(steamId || '').trim();
    if (!normalizedSteamId) {
      return 'Unknown';
    }

    if (displayCache.has(normalizedSteamId)) {
      return displayCache.get(normalizedSteamId);
    }

    let displayName = normalizedSteamId;
    if (this.isValidSteamId64(normalizedSteamId)) {
      try {
        const player = await this.ensureSteamIdExists(normalizedSteamId);
        displayName = this.formatProfileDisplay(normalizedSteamId, player);
      } catch (error) {
        this.logWarn(`Could not resolve Steam profile ${normalizedSteamId}: ${error.message || error}`);
      }
    }

    displayCache.set(normalizedSteamId, displayName);
    return displayName;
  }

  parseProfileTarget(rawTarget) {
    const target = String(rawTarget || '').trim();
    if (!target) {
      return null;
    }

    let urlText = target;
    if (/^(?:www\.)?steamcommunity\.com(?:[/?#]|$)/i.test(urlText)) {
      urlText = `https://${urlText}`;
    }

    let url;
    try {
      url = new URL(urlText);
    } catch (error) {
      return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'steamcommunity.com' && hostname !== 'www.steamcommunity.com') {
      return null;
    }

    let pathParts;
    try {
      pathParts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    } catch (error) {
      return { type: 'invalid' };
    }

    if (pathParts.length < 2) {
      return { type: 'invalid' };
    }

    const profileType = pathParts[0].toLowerCase();
    if (profileType === 'profiles') {
      return { type: 'steamid', steamId: pathParts[1] };
    }

    if (profileType === 'id') {
      return { type: 'vanity', vanityName: pathParts[1] };
    }

    return { type: 'invalid' };
  }

  async resolvePlayerTarget(rawTarget) {
    const target = String(rawTarget || '').trim();
    if (!target) {
      throw new Error('Provide a target.');
    }

    const steamProfileTarget = this.parseProfileTarget(target);
    if (steamProfileTarget) {
      if (steamProfileTarget.type === 'steamid') {
        const player = await this.ensureSteamIdExists(steamProfileTarget.steamId);
        return {
          type: 'steamid',
          value: steamProfileTarget.steamId,
          display: this.formatProfileDisplay(steamProfileTarget.steamId, player),
          source: 'profile-link',
          steamApiChecked: Boolean(player),
        };
      }

      if (steamProfileTarget.type === 'vanity') {
        const { steamId, steamApiChecked, player } = await this.resolveVanityUrl(steamProfileTarget.vanityName);
        return {
          type: 'steamid',
          value: steamId,
          display: this.formatProfileDisplay(steamId, player),
          source: 'vanity-link',
          steamApiChecked,
        };
      }

      throw new Error('Invalid Steam profile link. Use steamcommunity.com/profiles/<steamid64> or steamcommunity.com/id/<name>.');
    }

    if (/^\d{17}$/.test(target)) {
      const player = await this.ensureSteamIdExists(target);
      return {
        type: 'steamid',
        value: target,
        display: this.formatProfileDisplay(target, player),
        source: 'steamid',
        steamApiChecked: Boolean(player),
      };
    }

    return {
      type: 'nickname',
      value: target,
      display: target,
      source: 'nickname',
      steamApiChecked: false,
    };
  }

  async validateApiKey() {
    if (!this.activeApiKey) {
      return;
    }

    try {
      const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
      url.searchParams.set('key', this.activeApiKey);
      url.searchParams.set('steamids', '76561197960265728');

      const response = await fetch(url);
      if (response.status === 401 || response.status === 403) {
        this.activeApiKey = '';
        this.logWarn('STEAM_API_KEY is invalid; continuing with Steam lookups disabled.');
        return;
      }

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      this.logInfo('STEAM_API_KEY validated successfully.');
    } catch (error) {
      this.logWarn(`Could not validate STEAM_API_KEY: ${error.message || error}`);
    }
  }

  async resolveVanityUrl(vanityName) {
    const normalizedVanityName = String(vanityName || '').trim().toLowerCase();
    if (!normalizedVanityName) {
      throw new Error('Steam vanity profile name is empty.');
    }

    this.cleanupExpiredUsersSafely();
    const cachedUser = [...this.users.values()].find(
      (user) => user.vanityName.toLowerCase() === normalizedVanityName,
    );
    if (cachedUser) {
      const player = await this.ensureSteamIdExists(cachedUser.steamId);
      return {
        steamId: cachedUser.steamId,
        steamApiChecked: Boolean(player),
        player,
      };
    }

    if (this.pendingVanityResolutions.has(normalizedVanityName)) {
      return this.pendingVanityResolutions.get(normalizedVanityName);
    }

    const resolution = this.resolveVanityUrlFromApi(vanityName)
      .finally(() => this.pendingVanityResolutions.delete(normalizedVanityName));
    this.pendingVanityResolutions.set(normalizedVanityName, resolution);
    return resolution;
  }

  async resolveVanityUrlFromApi(vanityName) {
    if (!this.activeApiKey) {
      throw new Error('Steam vanity profile links require STEAM_API_KEY to resolve.');
    }

    const url = new URL('https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/');
    url.searchParams.set('key', this.activeApiKey);
    url.searchParams.set('vanityurl', vanityName);

    const response = await fetch(url);
    if (response.status === 401 || response.status === 403) {
      this.activeApiKey = '';
      this.logWarn('STEAM_API_KEY was rejected by Steam API; Steam lookups are disabled until restart.');
      throw new Error('Steam vanity profile links require a valid STEAM_API_KEY to resolve.');
    }

    if (!response.ok) {
      throw new Error(`Steam API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const steamId = data?.response?.steamid;
    if (data?.response?.success !== 1 || !steamId) {
      throw new Error(`Steam vanity profile "${vanityName}" was not found.`);
    }

    const player = await this.ensureSteamIdExists(steamId);
    this.saveVanityMapping(steamId, vanityName);
    return { steamId, steamApiChecked: Boolean(player), player };
  }

  saveVanityMapping(steamId, vanityName) {
    const normalizedVanityName = String(vanityName || '').trim().toLowerCase();
    const user = this.users.get(steamId);
    if (!user || !normalizedVanityName) {
      return;
    }

    let changed = user.vanityName !== vanityName;
    for (const otherUser of this.users.values()) {
      if (
        otherUser.steamId !== steamId
        && otherUser.vanityName.toLowerCase() === normalizedVanityName
      ) {
        otherUser.vanityName = '';
        changed = true;
      }
    }

    user.vanityName = String(vanityName).trim();
    if (changed) {
      this.saveCache();
    }
  }

  async ensureSteamIdExists(steamId) {
    if (!this.isValidSteamId64(steamId)) {
      throw new Error('Invalid Steam target. Provide a valid nickname, SteamID64 or Steam profile link.');
    }

    const player = await this.getPlayerSummary(steamId);
    if (!player && !this.activeApiKey) {
      return null;
    }

    if (!player) {
      throw new Error(`Steam profile not found for SteamID64 ${steamId}.`);
    }

    return player;
  }

  formatProfileDisplay(steamId, player) {
    if (!player) {
      return steamId;
    }

    const label = player.personaname || steamId;
    const escapedLabel = String(label).replace(/([\\[\]])/g, '\\$1');
    const profileUrl = player.profileurl || `https://steamcommunity.com/profiles/${steamId}/`;
    return `[${escapedLabel}](${profileUrl})`;
  }

  async getPlayerSummary(steamId) {
    const user = await this.getCachedUser(steamId);
    if (!user) {
      return null;
    }

    return {
      steamid: user.steamId,
      personaname: user.nickname,
      avatar: user.avatarUrl,
      profileurl: `https://steamcommunity.com/profiles/${user.steamId}/`,
    };
  }

  async fetchPlayerSummaryFromApi(steamId) {
    if (!this.activeApiKey) {
      return null;
    }

    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
    url.searchParams.set('key', this.activeApiKey);
    url.searchParams.set('steamids', steamId);

    const response = await fetch(url);
    if (response.status === 401 || response.status === 403) {
      this.activeApiKey = '';
      this.logWarn('STEAM_API_KEY was rejected by Steam API; Steam lookups are disabled until restart.');
      return null;
    }

    if (!response.ok) {
      throw new Error(`Steam API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data?.response?.players?.[0] || null;
  }

  loadCache() {
    this.users = new Map();
    if (!fs.existsSync(this.cacheFilePath)) {
      return;
    }

    try {
      const rawState = fs.readFileSync(this.cacheFilePath, 'utf8').trim();
      const parsedState = rawState ? JSON.parse(rawState) : {};
      const records = Array.isArray(parsedState) ? parsedState : parsedState.users;
      for (const record of Array.isArray(records) ? records : []) {
        const normalizedRecord = normalizeCacheRecord(record);
        if (normalizedRecord) {
          this.users.set(normalizedRecord.steamId, normalizedRecord);
        }
      }
      this.saveCache();
    } catch (error) {
      this.logWarn(`Failed to load ${this.cacheFilePath}; starting with an empty Steam user cache: ${error.message || error}`);
      this.users = new Map();
    }
  }

  saveCache() {
    const users = [...this.users.values()].sort((left, right) => left.steamId.localeCompare(right.steamId));
    if (users.length === 0 && !fs.existsSync(this.cacheFilePath)) {
      return;
    }

    fs.writeFileSync(this.cacheFilePath, `${JSON.stringify({ users }, null, 2)}\n`, 'utf8');
  }

  cleanupExpiredUsers(now = this.now()) {
    const todayKey = getLocalDateKey(now);
    if (this.lastCleanupDate === todayKey) {
      return;
    }

    const cutoffMs = now.getTime() - (Math.max(1, this.retentionDays) * MILLISECONDS_PER_DAY);
    let removedCount = 0;
    for (const [steamId, record] of this.users.entries()) {
      const referenceMs = new Date(record.lastFetchedAt).getTime();
      if (!Number.isFinite(referenceMs) || referenceMs < cutoffMs) {
        this.users.delete(steamId);
        removedCount += 1;
      }
    }

    this.lastCleanupDate = todayKey;
    if (removedCount > 0) {
      this.saveCache();
      this.logInfo(`Removed ${removedCount} expired Steam user cache ${removedCount === 1 ? 'entry' : 'entries'}.`);
    }
  }

  cleanupExpiredUsersSafely(now = this.now()) {
    try {
      this.cleanupExpiredUsers(now);
    } catch (error) {
      this.logWarn(`Failed to clean ${this.cacheFilePath}: ${error.message || error}`);
    }
  }

  scheduleDailyCleanup() {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
    }

    const now = this.now();
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const delayMs = Math.max(MILLISECONDS_PER_SECOND, nextDay.getTime() - now.getTime());
    this.cleanupTimer = setTimeout(() => {
      this.cleanupExpiredUsersSafely();
      this.scheduleDailyCleanup();
    }, delayMs);
  }

  async getCachedUser(steamId) {
    const normalizedSteamId = String(steamId || '').trim();
    if (!normalizedSteamId) {
      return null;
    }

    const now = this.now();
    this.cleanupExpiredUsersSafely(now);
    const storedUser = this.users.get(normalizedSteamId) || null;
    const cachedUser = storedUser?.lastFetchedAt ? storedUser : null;

    if (this.pendingRefreshes.has(normalizedSteamId)) {
      return this.pendingRefreshes.get(normalizedSteamId);
    }

    if (
      isSameLocalDay(storedUser?.lastFetchedAt, now)
      || !this.activeApiKey
    ) {
      return cachedUser;
    }

    const refresh = this.refreshCachedUser(normalizedSteamId, cachedUser)
      .finally(() => this.pendingRefreshes.delete(normalizedSteamId));
    this.pendingRefreshes.set(normalizedSteamId, refresh);
    return refresh;
  }

  async refreshCachedUser(steamId, cachedUser) {
    try {
      const player = await this.fetchPlayerSummaryFromApi(steamId);
      if (!player) {
        return cachedUser;
      }

      const refreshedUser = {
        steamId,
        vanityName: cachedUser?.vanityName || '',
        nickname: String(player.personaname || ''),
        avatarUrl: String(player.avatar || ''),
        lastFetchedAt: this.now().toISOString(),
      };
      this.users.set(steamId, refreshedUser);
      this.saveCache();
      return refreshedUser;
    } catch (error) {
      if (!cachedUser) {
        throw error;
      }

      this.logWarn(`Could not refresh cached Steam user ${steamId}; using saved information: ${error.message || error}`);
      return cachedUser;
    }
  }
}

module.exports = { SteamService };
