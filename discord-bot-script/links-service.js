const fs = require('fs');

function normalizeLinkName(value) {
  return String(value || '').trim();
}

function getLinkNameKey(value) {
  return normalizeLinkName(value).normalize('NFKC').toLocaleLowerCase('en-US');
}

function normalizeDiscordLink(value) {
  return String(value || '').trim().replace(/^<|>$/g, '');
}

function validateLinkName(name) {
  const normalizedName = normalizeLinkName(name);
  if (!normalizedName) {
    throw new Error('Link name cannot be empty.');
  }
  if (normalizedName.length > 100) {
    throw new Error('Link name cannot exceed 100 characters.');
  }
  return normalizedName;
}

function validateDiscordLink(link) {
  const normalizedLink = normalizeDiscordLink(link);
  const discordLinkPattern = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/\d{17,20}\/\d{17,20}(?:\/\d{17,20})?\/?(?:\?.*)?$/i;
  if (!discordLinkPattern.test(normalizedLink)) {
    throw new Error('Link must be a Discord channel or message URL.');
  }
  return normalizedLink;
}

class LinksService {
  constructor({ filePath }) {
    this.filePath = filePath;
  }

  initialize() {
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]\n', 'utf8');
    }
  }

  getLinks() {
    this.initialize();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Could not read links data: ${error.message || error}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Links data must be a JSON array.');
    }

    return parsed
      .filter((entry) => entry && typeof entry.name === 'string' && typeof entry.link === 'string')
      .map((entry) => ({ name: entry.name.trim(), link: entry.link.trim() }))
      .filter((entry) => entry.name && entry.link)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  }

  findLink(name) {
    const key = getLinkNameKey(name);
    return this.getLinks().find((entry) => getLinkNameKey(entry.name) === key) || null;
  }

  addLink(name, link) {
    const normalizedName = validateLinkName(name);
    const normalizedLink = validateDiscordLink(link);
    const links = this.getLinks();
    if (links.some((entry) => getLinkNameKey(entry.name) === getLinkNameKey(normalizedName))) {
      throw new Error(`A link named "${normalizedName}" already exists.`);
    }
    links.push({ name: normalizedName, link: normalizedLink });
    this.saveLinks(links);
    return { name: normalizedName, link: normalizedLink };
  }

  removeLink(name) {
    const key = getLinkNameKey(name);
    const links = this.getLinks();
    const index = links.findIndex((entry) => getLinkNameKey(entry.name) === key);
    if (index === -1) {
      throw new Error(`Link "${normalizeLinkName(name)}" was not found.`);
    }
    const [removed] = links.splice(index, 1);
    this.saveLinks(links);
    return removed;
  }

  editLink(name, newName, newLink) {
    const links = this.getLinks();
    const key = getLinkNameKey(name);
    const index = links.findIndex((entry) => getLinkNameKey(entry.name) === key);
    if (index === -1) {
      throw new Error(`Link "${normalizeLinkName(name)}" was not found.`);
    }
    if (!normalizeLinkName(newName) && !normalizeDiscordLink(newLink)) {
      throw new Error('Provide a new name, a new link, or both.');
    }

    const edited = {
      name: normalizeLinkName(newName) ? validateLinkName(newName) : links[index].name,
      link: normalizeDiscordLink(newLink) ? validateDiscordLink(newLink) : links[index].link,
    };
    const editedKey = getLinkNameKey(edited.name);
    if (links.some((entry, entryIndex) => entryIndex !== index && getLinkNameKey(entry.name) === editedKey)) {
      throw new Error(`A link named "${edited.name}" already exists.`);
    }

    links[index] = edited;
    this.saveLinks(links);
    return edited;
  }

  saveLinks(links) {
    const sortedLinks = [...links]
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    fs.writeFileSync(this.filePath, `${JSON.stringify(sortedLinks, null, 2)}\n`, 'utf8');
  }
}

module.exports = { LinksService };
