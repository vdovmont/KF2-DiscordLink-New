# KF2-DiscordLink-Edited

# How to use

Download the released version it appears on the right of your screen
and also download **run.bat** and edit your info in the file there

or run this on your cmd (must be in the same directory)


java -jar KF2DiscordMut.jar port webhookURL SteamAPIKey CDAVatarURL(optional) DiscordBotToken(optional) ChannelID(optional)

***fill 0 in optional arguments if you don't want to use that***

***You need to provide DiscordBotToken if you want msgs to be sent to the kf2 server as well as ChannelID***

# How to build in Windows

As prerequisite you need to install JDK 21 or newer.
Now open terminal inside this project folder and run next command:

```bash
.\gradlew clean shadowJar
```

Now you can look for your .jar file inside **build/libs** folder. To run it through console use this command:

```bash
java -jar build/KF2-DiscordLink-New.jar
```