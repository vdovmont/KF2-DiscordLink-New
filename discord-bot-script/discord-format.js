const DISCORD_MARKDOWN_CHARACTER_PATTERN = /([\\`*_{}\[\]()#+\-|>~])/g;
const ESCAPED_DISCORD_MARKDOWN_CHARACTER_PATTERN = /\\([\\`*_{}\[\]()#+\-|>~])/g;

function escapeDiscordMarkdownText(value) {
  return String(value ?? '').replace(DISCORD_MARKDOWN_CHARACTER_PATTERN, '\\$1');
}

function unescapeDiscordMarkdownText(value) {
  return String(value ?? '').replace(ESCAPED_DISCORD_MARKDOWN_CHARACTER_PATTERN, '$1');
}

module.exports = {
  escapeDiscordMarkdownText,
  unescapeDiscordMarkdownText,
};
