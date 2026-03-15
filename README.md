# KF2-DiscordLink-Edited

# How to use

Download the released version it appears on the right of your screen
and also download **run.bat** and edit your info in the file there

or run this on your cmd (must be in the same directory)
```bash
java -jar KF2-Discord-Linker-1.1.5.jar port webhookURL SteamAPIKey CDAVatarURL(optional) DiscordBotToken(optional) ChannelID(optional) RequestChannelID(optional) RequestTag(optional)
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
java -jar build/libs/KF2-Discord-Linker-1.1.5.jar 2424 https://killingfloor2.com/ ad2eSDSGJSU2dfd148 0 0 0 0 0
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

Discord Developer Portal:

https://discord.com/developers/applications

## 4. Run the bot

Open a terminal in the `discord-bot-script` folder and run:

```bash
node .\index.js
```

If everything is configured correctly, the bot will start, register its slash commands for your server, and respond to them in Discord.