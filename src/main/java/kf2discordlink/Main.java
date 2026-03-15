package kf2discordlink;
public class Main {

	public static void main(String[] args) throws InterruptedException {
		if(args.length<8)
		{
			printUsage();
			return;
		}
		System.out.println("\r\nDiscord Link by Patrick.\r\n");
		MainListener mainlistener = new MainListener(Integer.parseInt(args[0]),args[1],args[2],args[3],args[4],args[5],args[6],args[7]);
		
		
	}
	
	private static void printUsage()
	{
		System.out.println("It needs to have 8 arguments. containing port, webHookURL,SteamAPIKey,CDAVatarURL(optional),DiscordBotToken(optional),ChannelID(optional),RequestChannelID(optional),RequestTag(optional)\n"
				+ "ex. java -jar KF2-Discord-Linker-1.1.2.jar 2424 https://killingfloor2.com/ ad2eSDSGJSU2dfd148 0 0 0 0 0\n"
				+ "(place 0 if you don't want to use this functionality)");
	}

}
