package kf2discordlink;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
public class Main {

	public static void main(String[] args) throws InterruptedException {
		String[] resolvedArgs = args;
		if (args.length == 0) {
			String[] fileArgs = tryReadArgsFromFile("options.txt");
			if (fileArgs == null) {
				printUsage();
				return;
			}
			resolvedArgs = fileArgs;
		} else if (args.length >= 8) {
			writeArgsToFile("options.txt", args);
		}
		
		if(resolvedArgs.length<8)
		{
			printUsage();
			return;
		}
		System.out.println("\r\nDiscord Link by Patrick.\r\n");
		MainListener mainlistener = new MainListener(Integer.parseInt(resolvedArgs[0]),resolvedArgs[1],resolvedArgs[2],resolvedArgs[3],resolvedArgs[4],resolvedArgs[5],resolvedArgs[6],resolvedArgs[7]);
		
		
	}
	
	private static void printUsage()
	{
		System.out.println("It needs to have 8 arguments. containing port, webHookURL,SteamAPIKey,CDAVatarURL(optional),DiscordBotToken(optional),ChannelID(optional),RequestChannelID(optional),RequestTag(optional)\n"
				+ "ex. java -jar KF2-Discord-Linker-1.1.2.jar 2424 https://killingfloor2.com/ ad2eSDSGJSU2dfd148 0 0 0 0 0\n"
				+ "or run with no arguments to load from options.txt\n"
				+ "(place 0 if you don't want to use this functionality)");
	}
	
	private static void writeArgsToFile(String filename, String[] args)
	{
		if (args.length < 8) {
			return;
		}
		List<String> lines = List.of(
			"port:"+args[0],
			"webHookURL:"+args[1],
			"SteamAPIKey:"+args[2],
			"CDAVatarURL:"+args[3],
			"DiscordBotToken:"+args[4],
			"ChannelID:"+args[5],
			"RequestChannelID:"+args[6],
			"RequestTag:"+args[7]
		);
		try {
			Files.write(Paths.get(filename), lines, StandardCharsets.UTF_8);
		} catch (IOException e) {
			System.out.println("Failed to write "+filename+": "+e.getMessage());
		}
	}
	
	private static String[] tryReadArgsFromFile(String filename)
	{
		Path path = Paths.get(filename);
		if (!Files.exists(path)) {
			System.out.println("Missing "+filename+". Run once with full arguments to create it.");
			return null;
		}
		Map<String, String> values = new HashMap<>();
		try {
			for (String line : Files.readAllLines(path, StandardCharsets.UTF_8)) {
				String trimmed = line.trim();
				if (trimmed.isEmpty() || trimmed.startsWith("#")) {
					continue;
				}
				int colonIndex = trimmed.indexOf(':');
				if (colonIndex <= 0) {
					continue;
				}
				String key = trimmed.substring(0, colonIndex).trim();
				String value = trimmed.substring(colonIndex + 1).trim();
				values.put(key, value);
			}
		} catch (IOException e) {
			System.out.println("Failed to read "+filename+": "+e.getMessage());
			return null;
		}
		
		String[] requiredKeys = new String[] {
			"port","webHookURL","SteamAPIKey","CDAVatarURL","DiscordBotToken","ChannelID","RequestChannelID","RequestTag"
		};
		for (String key : requiredKeys) {
			if (!values.containsKey(key)) {
				System.out.println("Missing key in "+filename+": "+key);
				return null;
			}
		}
		
		return new String[] {
			values.get("port"),
			values.get("webHookURL"),
			values.get("SteamAPIKey"),
			values.get("CDAVatarURL"),
			values.get("DiscordBotToken"),
			values.get("ChannelID"),
			values.get("RequestChannelID"),
			values.get("RequestTag")
		};
	}

}
