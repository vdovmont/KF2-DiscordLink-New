package kf2discordlink;
import java.io.*;
import java.net.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.io.IOException;
import java.util.regex.Pattern;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

import org.json.JSONObject;
import org.json.JSONArray;

public class MainListener {
	  
	public String apiURL = "";
	public String SteamAPIKey ="";
	public String CDAvatarURL= "";
	public String ChannelID = "";
	public String Difficulty = "";
	private static final int MIN_PORT = 1;
	private static final int MAX_PORT = 65535;
	private static final int CONTROL_PORT_OFFSET = 100;
	private static final int CONTROL_REQUEST_TIMEOUT_MS = 60000;
	private Socket socket;
	private PrintWriter out;
	private BufferedReader in;
	private int port;
	private int discordBotPort;
	private DiscordBot Bot;
	private Path heartbeatFilePath;
	private ServerSocket controlServerSocket;
	private final Object pendingRequestLock = new Object();
	private PendingControlRequest pendingControlRequest;

	private static class PendingControlRequest {
		public final Socket socket;
		public final PrintWriter writer;

		PendingControlRequest(Socket socket, PrintWriter writer) {
			this.socket = socket;
			this.writer = writer;
		}
	}
	 
	MainListener(int port,String apiURL,String SteamAPIKey,String CDAvatarURL,String BotToken,String ChannelID,String Difficulty) throws InterruptedException
	{	
		this.port = port;
		this.discordBotPort = resolveControlPort(port, CONTROL_PORT_OFFSET);
		this.apiURL=apiURL;
		this.SteamAPIKey=SteamAPIKey;
		this.CDAvatarURL=CDAvatarURL;
		this.ChannelID=ChannelID;
		this.Difficulty=Difficulty;
		if(!BotToken.equals("0"))
		{	
			System.out.println("Initializing Discord Bot");
			Bot = new DiscordBot(BotToken);
		}

		startHeartbeatLoop();
		startControlServer();
		
		new Thread(new Runnable() {
			@Override
			public void run(){
				SetupConnection();
			}
		}).start();
	}

	private int resolveControlPort(int basePort, int offset)
	{
		int rawPort = basePort + offset;
		if (rawPort <= MAX_PORT) {
			return rawPort;
		}

		return rawPort - MAX_PORT;
	}

	private void startHeartbeatLoop()
	{
		if (!hasActiveDifficulty()) {
			return;
		}

		heartbeatFilePath = Paths.get("heartbeat", Difficulty + ".json");
		deleteHeartbeat();
		writeHeartbeat();

		Runtime.getRuntime().addShutdownHook(new Thread(() -> {
			deleteHeartbeat();
			closePendingControlRequest();
			closeControlServer();
		}));

		Thread heartbeatThread = new Thread(() -> {
			while (true) {
				try {
					Thread.sleep(30000);
					writeHeartbeat();
				} catch (InterruptedException ignored) {
					Thread.currentThread().interrupt();
					return;
				}
			}
		});
		heartbeatThread.setDaemon(true);
		heartbeatThread.setName("heartbeat-writer");
		heartbeatThread.start();
	}

	private void startControlServer()
	{
		if (!hasActiveDifficulty()) {
			return;
		}

		Thread controlServerThread = new Thread(() -> {
			try {
				controlServerSocket = new ServerSocket();
				controlServerSocket.bind(new InetSocketAddress("127.0.0.1", discordBotPort));
				System.out.println("Control server listening on 127.0.0.1:" + discordBotPort);

				while (true) {
					Socket clientSocket = controlServerSocket.accept();
					handleControlClient(clientSocket);
				}
			} catch (IOException e) {
				System.out.println("Control server stopped: " + e.getMessage());
			}
		});
		controlServerThread.setDaemon(true);
		controlServerThread.setName("control-server");
		controlServerThread.start();
	}

	private void handleControlClient(Socket clientSocket)
	{
		new Thread(() -> {
			try {
				clientSocket.setSoTimeout(10000);
				BufferedReader clientReader = new BufferedReader(
					new InputStreamReader(clientSocket.getInputStream(), StandardCharsets.UTF_8)
				);
				PrintWriter clientWriter = new PrintWriter(
					new OutputStreamWriter(clientSocket.getOutputStream(), StandardCharsets.UTF_8),
					true
				);

				String line = clientReader.readLine();
				if (line == null || line.trim().isEmpty()) {
					sendJsonAndClose(clientSocket, clientWriter, null, "Missing payload");
					return;
				}

				JSONObject request = new JSONObject(line);
				String payload = request.optString("payload", "").trim();
				if (payload.isEmpty()) {
					sendJsonAndClose(clientSocket, clientWriter, null, "Missing payload");
					return;
				}

				synchronized (pendingRequestLock) {
					if (pendingControlRequest != null) {
						sendJsonAndClose(clientSocket, clientWriter, null, "Relay is already processing another request");
						return;
					}

					pendingControlRequest = new PendingControlRequest(clientSocket, clientWriter);
				}

				try {
					sendMessage(payload);
				} catch (IOException e) {
					clearPendingControlRequest();
					sendJsonAndClose(clientSocket, clientWriter, null, "Failed to forward payload to KF2");
					return;
				}

				Thread timeoutThread = new Thread(() -> {
					try {
						Thread.sleep(CONTROL_REQUEST_TIMEOUT_MS);
						synchronized (pendingRequestLock) {
							if (pendingControlRequest != null && pendingControlRequest.socket == clientSocket) {
								sendJsonAndClose(
									pendingControlRequest.socket,
									pendingControlRequest.writer,
									null,
									"Timed out waiting for /dsresponse"
								);
								pendingControlRequest = null;
							}
						}
					} catch (InterruptedException ignored) {
						Thread.currentThread().interrupt();
					}
				});
				timeoutThread.setDaemon(true);
				timeoutThread.start();
			} catch (Exception e) {
				try {
					clientSocket.close();
				} catch (IOException ignored) {}
			}
		}).start();
	}

	private void sendJsonAndClose(Socket socket, PrintWriter writer, String payload, String error)
	{
		try {
			JSONObject response = new JSONObject();
			if (payload != null) {
				response.put("payload", payload);
			}
			if (error != null) {
				response.put("error", error);
			}
			writer.println(response.toString());
		} finally {
			try {
				socket.close();
			} catch (IOException ignored) {}
		}
	}

	private void clearPendingControlRequest()
	{
		synchronized (pendingRequestLock) {
			pendingControlRequest = null;
		}
	}

	private void closePendingControlRequest()
	{
		synchronized (pendingRequestLock) {
			if (pendingControlRequest == null) {
				return;
			}

			try {
				pendingControlRequest.socket.close();
			} catch (IOException ignored) {}

			pendingControlRequest = null;
		}
	}

	private void closeControlServer()
	{
		if (controlServerSocket == null) {
			return;
		}

		try {
			controlServerSocket.close();
		} catch (IOException ignored) {}
	}

	private boolean hasActiveDifficulty()
	{
		return !Difficulty.equals("0") && !Difficulty.isEmpty();
	}

	private void writeHeartbeat()
	{
		if (heartbeatFilePath == null) {
			return;
		}

		try {
			Files.createDirectories(heartbeatFilePath.getParent());

			JSONObject heartbeat = new JSONObject();
			heartbeat.put("difficulty", Difficulty);
			heartbeat.put("port", port);
			heartbeat.put("discordBotPort", discordBotPort);
			heartbeat.put("updatedAt", System.currentTimeMillis());

			Files.writeString(
				heartbeatFilePath,
				heartbeat.toString(2),
				StandardCharsets.UTF_8
			);
		} catch (IOException e) {
			System.out.println("Failed to write heartbeat file: " + e.getMessage());
		}
	}

	private void deleteHeartbeat()
	{
		if (heartbeatFilePath == null) {
			return;
		}

		try {
			Files.deleteIfExists(heartbeatFilePath);
		} catch (IOException e) {
			System.out.println("Failed to delete heartbeat file: " + e.getMessage());
		}
	}
	
	private void SetupConnection()
	{
		if (Bot != null) {
			Bot.SetListener(this);
		}

		while (true) {
			try {
				socket = new Socket();
				socket.connect(new InetSocketAddress("127.0.0.1", port), 5000);

				out = new PrintWriter(socket.getOutputStream(), true);
				in = new BufferedReader(new InputStreamReader(socket.getInputStream(),"utf-8"));

				System.out.println("Connected, listening...");
				
				String inputLine;
				while ((inputLine = in.readLine()) != null) {
					PostRequest(UnicodeConvert(inputLine));
				}

			} catch (IOException e) {
				System.out.println("Connection failed: " + e.getMessage());
			} finally {
				stopConnection();
			}

			try {
				DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
				String timestamp = LocalDateTime.now().format(formatter);
				System.out.println("[" + timestamp + "] Lost connection to the server. Retrying in 30 seconds...");
				Thread.sleep(30000);
			} catch (InterruptedException ignored) {}
		}
	}
	
	private static String UnicodeConvert(String Message)
	{	
		String[] array = Message.split("/");
		String Text ="";
		
		for(int numi=0;numi<Message.split("/").length;numi++)
		{
			Text = Text + (char)(Integer.parseInt(array[numi]));
		}
		return Text;
	}
	
	public void sendMessage(String msg) throws IOException{
        if (out == null) {
        	throw new IOException("KF2 socket is not connected");
        }
        out.println(msg);
    }

	private void stopConnection(){
        try { if (in != null) in.close(); } catch(Exception ignored){}
        try { if (out != null) out.close(); } catch(Exception ignored){}
		try { if (socket != null) socket.close(); } catch(Exception ignored){}
    }
    
	private String[] ExtractMessageInfo(String Message)
    {	
    	String[] OutString = new String[4];
 
    	String[] RawArr = Message.split(Pattern.quote("^$"));
    	if (RawArr.length < 3)
    	{
    		throw new IllegalArgumentException("Unexpected relay payload: " + Message);
    	}
    	if (RawArr[0].equals("CDC"))
    	{
    		OutString[0]="1";OutString[1]=RawArr[1];OutString[2]=RawArr[2];OutString[3]=CDAvatarURL;
    		return OutString;
    	}
    	
    	Long SteamID =Long.decode(RawArr[0]);
    	
    	String Username = RawArr[1];
    	String content=RawArr[2];
    	
    	try{
	        URL url = URI.create("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key="+SteamAPIKey+"&steamids="+SteamID).toURL();
	        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
			connection.setConnectTimeout(5000);
			connection.setReadTimeout(5000);
	        connection.setRequestMethod("GET");
	        StringBuilder result = new StringBuilder();
	        try (BufferedReader reader = new BufferedReader(
	                  new InputStreamReader(connection.getInputStream()))) {
	          for (String line; (line = reader.readLine()) != null; ) {
	              result.append(line);
	          }
	      }

	      JSONObject json = new JSONObject(result.toString());
	      
	      JSONArray arr = json.getJSONObject("response").getJSONArray("players");
	      String AvatarURL=arr.getJSONObject(0).getString("avatar");
	      OutString[0]=Long.toString(SteamID);OutString[1]=Username;OutString[2]=content;OutString[3]=AvatarURL;
	      
	    } catch (Exception e) {
	        System.out.println(e);
	        System.out.println("Could not retrieve"+Username+"'s Avatar");
	        
	    }
		
    	return OutString;
    }
	private void PostRequest(String Message)
    {
     	 try{
     	        if (tryHandleDsResponse(Message)) {
     	        	return;
     	        }
     	        
     	        String[] payloadData = ExtractMessageInfo(Message);
     	        
     	        System.out.println(payloadData[1]+": "+payloadData[2]);
     	        
     	        URL url = URI.create(apiURL).toURL();
     	        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
    	        connection.setRequestMethod("POST");
    	        connection.setDoOutput(true);
    	        connection.setRequestProperty("Content-Type","application/json");
    	        connection.setRequestProperty("Accept", "application/json");
    	        String payload = "{\r\n"
    	        		+ "  \"username\": \""+payloadData[1]+"\",\r\n"
    	        		+ "  \"avatar_url\": \""+payloadData[3]+"\",\r\n"
    	        		+ "  \"content\": \""+payloadData[2]+"\"}";
    	        		
    	        byte[] out = payload.getBytes(StandardCharsets.UTF_8);
    	        OutputStream stream = connection.getOutputStream();
    	        stream.write(out);
    	        
    	        System.out.println(connection.getResponseCode() + " " + connection.getResponseMessage());
    	        stream.flush();
    	        connection.disconnect();
    	    } catch (Exception e) {
    	        System.out.println(e);
    	        e.printStackTrace();
    	        System.out.println("Failed to Send a Request");
    	    }
    }
	
	private boolean tryHandleDsResponse(String content)
	{
		String prefix = "/dsresponse ";
		if (!content.startsWith(prefix)) {
			return false;
		}
		
		String responseText = content.substring(prefix.length());
		String payload = "/dsresponse " + Difficulty + " " + responseText;

		synchronized (pendingRequestLock) {
			if (pendingControlRequest != null) {
				sendJsonAndClose(pendingControlRequest.socket, pendingControlRequest.writer, payload, null);
				pendingControlRequest = null;
			}
		}
		return true;
	}
}
