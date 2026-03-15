package kf2discordlink;
import java.io.IOException;

import net.dv8tion.jda.api.JDA;
import net.dv8tion.jda.api.JDABuilder;
import net.dv8tion.jda.api.entities.Activity;
import net.dv8tion.jda.api.entities.Message;
import net.dv8tion.jda.api.entities.channel.middleman.MessageChannel;
import net.dv8tion.jda.api.events.message.MessageReceivedEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;
import net.dv8tion.jda.api.requests.GatewayIntent;


public class DiscordBot extends ListenerAdapter
{	
	public MainListener Listener;
	private JDA jda;
    DiscordBot(String args)
    {
        if(args.equals("0"))
        {
        	return;
        }
        
        jda = JDABuilder.createLight(args, GatewayIntent.GUILD_MESSAGES, GatewayIntent.DIRECT_MESSAGES, GatewayIntent.MESSAGE_CONTENT)
            .addEventListeners(this)
            .setActivity(Activity.playing("KF2 is FUN :)"))
            .build();
    }
    public void SetListener(MainListener Listener)
    {
    	this.Listener = Listener;
    }
    @Override
    public void onMessageReceived(MessageReceivedEvent event)
    {
        Message msg = event.getMessage();
    
        if (Listener == null) {
        	return;
        }
        
        long channelId = msg.getChannel().getIdLong();
        String content = msg.getContentRaw();
        
        if (channelId == Long.parseLong(Listener.RequestChannelID) && event.getAuthor().isBot())
        {
        	String requestText = extractRequestText(content);
        	if (requestText != null) {
        		try {
        			Listener.sendMessage(requestText);
        		} catch (IOException e) {
        			e.printStackTrace();
        			System.out.println("Cannot send "+requestText);
        		}
        		return;
        	}
        }
        
        if(channelId==Long.parseLong(Listener.ChannelID) && !event.getAuthor().isBot())
        {
        	try {
    		    Listener.sendMessage("[Discord] "+getDisplayName(event)+" "+content);
    		} catch (IOException e) {
    			e.printStackTrace();
    			System.out.println("Cannot send "+content);
    		}
        }
        
    }
    
    private String extractRequestText(String content)
    {
    	if (Listener.RequestChannelID.equals("0") || Listener.RequestTag.equals("0") || Listener.RequestTag.isEmpty()) {
    		return null;
    	}
    	
    	String prefix = "/dsrequest " + Listener.RequestTag;
    	if (!content.startsWith(prefix)) {
    		return null;
    	}
    	
    	if (content.length() == prefix.length()) {
    		return null;
    	}
    	
    	if (content.charAt(prefix.length()) != ' ') {
    		return null;
    	}
    	
    	String payload = content.substring(prefix.length() + 1);
    	if (payload.trim().isEmpty()) {
    		return null;
    	}
    	return "/dsrequest " + payload;
    }

    private String getDisplayName(MessageReceivedEvent event)
    {
    	if (event.isFromGuild() && event.getMember() != null) {
    		return event.getMember().getEffectiveName();
    	}
    	return event.getAuthor().getName();
    }
    
    public void sendToChannel(String channelId, String message)
    {
    	if (jda == null || channelId == null || channelId.equals("0")) {
    		return;
    	}
    	
    	MessageChannel channel = jda.getChannelById(MessageChannel.class, Long.parseLong(channelId));
    	if (channel == null) {
    		System.out.println("Cannot find channel id "+channelId);
    		return;
    	}
    	
    	channel.sendMessage(message).queue();
    }
}
