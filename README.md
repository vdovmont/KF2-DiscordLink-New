# KF2-DiscordLink-Edited

# How to use

Download the released version it appears on the right of your screen
and also download **run.bat** and edit your info in the file there

or run this on your cmd (must be in the same directory)
```bash
java -jar KF2-Discord-Linker-1.1.6.jar port webhookURL SteamAPIKey CDAVatarURL(optional) DiscordBotToken(optional) ChannelID(optional) Difficulty(optional)
```

***fill 0 in optional arguments if you don't want to use that***

***You need to provide DiscordBotToken if you want msgs to be sent to the kf2 server as well as ChannelID***

# How to build in Windows

As prerequisite you need to install JDK 21 or newer.

If you already has it - then just open terminal inside this project folder and run next command:

```bash
.\gradlew clean shadowJar
```

Now you can look for your .jar file inside **build/libs** folder. Or you can run it through the same console by using this command:

```bash
java -jar build/libs/KF2-Discord-Linker-1.1.6.jar 2424 https://killingfloor2.com/ ad2eSDSGJSU2dfd148 0 0 0 0
```

# How to use discord script in Windows

This section explains how to set up and run the Discord bot script on Windows.

## 1. Install Node.js

Download and install the current LTS version of Node.js:

https://nodejs.org

After installation, open Command Prompt and check that Node.js and npm are available:

```bash
node -v
npm -v
```

Example output:

```bash
v20.11.1
10.2.4
```

If both commands print a version number, Node.js is installed correctly.

## 2. Install dependencies

Open a terminal as an Administrator in the `discord-bot-script` folder and run:

```bash
npm install discord.js dotenv
```

This will install the required libraries used by the bot.

## 3. Create the `.env` file

Inside the `discord-bot-script` folder, create a `.env` file based on `example.env`.

You will need the following values:

- `DISCORD_TOKEN` - from the Discord Developer Portal under `Bot`
- `CLIENT_ID` - from `General Information`
- `GUILD_ID` - enable Discord Developer Mode, then right-click your server and copy its ID
- `STEAM_API_KEY` - optional, used to show Steam avatars when forwarding KF2 chat through a webhook
- `KF2_SERVER_1_*` through `KF2_SERVER_5_*` - direct KF2 socket and Discord channel settings

Discord Developer Portal:

https://discord.com/developers/applications

For each KF2 server block in `.env`:

- `KF2_SERVER_N_ENABLED` turns that server connection on or off.
- `KF2_SERVER_N_HOST` and `KF2_SERVER_N_PORT` point to the same KF2 socket port the Java relay used before.
- `KF2_SERVER_N_DISCORD_CHANNEL_ID` is the Discord channel used for chat forwarding.
- `KF2_SERVER_N_WEBHOOK_URL` is optional. If set, KF2 messages are posted through that webhook with player names and avatars. If empty, the bot posts plain text messages.
- `KF2_SERVER_N_FORWARD_KF2_TO_DISCORD` controls KF2 chat to Discord.
- `KF2_SERVER_N_FORWARD_DISCORD_TO_KF2` controls Discord chat to KF2.
- `KF2_SERVER_N_COMMANDS_ENABLED` controls whether slash commands can use that connected server.

The bot needs the `MESSAGE CONTENT INTENT` enabled in the Discord Developer Portal if you want Discord channel messages forwarded back to KF2.

While the bot is running, changes to the `KF2_SERVER_1_*` through `KF2_SERVER_5_*` blocks in `discord-bot-script/.env` are reloaded automatically. Changing a server host or port restarts only that KF2 socket connection. Discord token, client ID, guild ID, and slash command definitions still require restarting the bot.

## 4. Run the bot

Open a terminal in the `discord-bot-script` folder and run:

```bash
node .\index.js
```

If everything is configured correctly, the bot will start, register its slash commands for your server, and respond to them in Discord.
