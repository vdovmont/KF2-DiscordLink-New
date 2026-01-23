# KF2-DiscordLink-Edited

# How to use

Download the released version it appears on the right of your screen
and also download **run.bat** and edit your info in the file there

or run this on your cmd (must be in the same directory)
```bash
java -jar KF2-Discord-Linker-1.1.0.jar port webhookURL SteamAPIKey CDAVatarURL(optional) DiscordBotToken(optional) ChannelID(optional)
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
java -jar build/libs/KF2-Discord-Linker-1.1.3.jar 2424 https://killingfloor2.com/ ad2eSDSGJSU2dfd148 0 0 0 0 0
```

Linker now store arguments into options.txt file (file location depends from where you're running run command). To generate it, just run linker with full arguments once (like in example above) and all parameters will be saved into file. Next time you can run linker without any arguments - they'll be pulled from file automaticaly:

```bash
java -jar build/libs/KF2-Discord-Linker-1.1.3.jar
```