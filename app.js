const express = require('express');
const dotenv  = require('dotenv');
const { google } = require('googleapis');
const { gmail } = require('googleapis/build/src/apis/gmail');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CLIENT_REDIRECT_URI
);

const accessTokens = {};

app.get('/connect', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'],
        prompt: 'consent'
    });

    res.redirect(url);
});

app.get('/', (req, res) => {
    console.log("HELLO WORLD!!");
    
    res.status(200).send("Hello World!");
})

app.post('/webhook', async (req, res) => {
    console.log("Gmail webhook recieved");

    console.log(JSON.stringify(req.body));

    const { message, subscription } = req.body;

    if (!message || !message.data || !message.messageId) {
        console.log("no message found");
    }

    const encodedMessage = message.data;
    console.log('encoded message: ', encodedMessage);
    console.log("message: ", JSON.stringify(message));
    console.log("message Id: ", message.messageId);
    console.log("message Id2: ", message.message_id);
    
    const decodedMessage = JSON.parse(
        Buffer.from(encodedMessage, "base64").toString("utf-8")
    );

    console.log("decoded message: ", decodedMessage);
    if (!decodedMessage.emailAddress) {
        res.status(500).send("Invalid message format!");
    }
    
    console.log('email address: ', decodedMessage.emailAddress);

    const emailCreds = accessTokens[decodedMessage.emailAddress];

    if (!emailCreds)    return res.status(500).send(`${decodedMessage.emailAddress} not authenticated!`);

    console.log('email creds: ', emailCreds);

    await getMessages(emailCreds, decodedMessage.emailAddress, decodedMessage.historyId);

    return res.status(200).send();
})

app.get('/auth', async (req, res) => {
    const code = req.query.code;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log("tokens: ", tokens);
    console.log("code: ", code);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const userEmail = profile.data.emailAddress;
    
    try {
        const watchRes = await gmail.users.watch({
            userId: 'me',
            requestBody: {
                labelIds: ['SENT', 'INBOX'],
                topicName: 'projects/nifty-quanta-446812-k9/topics/Fpylas-messages'
            }
        });

      const { historyId, expiration } = watchRes.data;
      console.log(`✅ Watch set for ${userEmail}`);
      console.log(`📜 historyId: ${historyId}, 🕒 expires at: ${new Date(Number(expiration))}`);

      accessTokens[userEmail] = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiry: tokens.expiry_date,
        watchExpiration: expiration,
        historyId: historyId
      }

      console.log('accessTokens: ', JSON.stringify(accessTokens))

      res.send(`✅ Watch set for ${userEmail}. historyId: ${historyId}`);
    } catch (err) {
        console.log("error: ", err);
        res.status(500).send("failed to setup gmail watch");
    }


    return res.status(200).end();
})

const getMessages = async (emailCreds, userEmail, historyId) => {
    oauth2Client.setCredentials({
        access_token: emailCreds.accessToken,
        refresh_token: emailCreds.refreshToken,
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
        expiry_date: emailCreds.expiry
    })
    
    const gmailClient = google.gmail({
        version: "v1",
        auth: oauth2Client
    });

    const messagesRes = await gmailClient.users.history.list({
        userId: 'me',
        startHistoryId: historyId
    })

    console.log("messages: ", JSON.stringify(messagesRes));

    if (!messagesRes || !messagesRes.data) {
        throw new Error("no messages found for user: " + userEmail);
    }

    for (const message of messagesRes.data) {
        const messageData = await gmailClient.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full'
        })

        console.log('message data: ', messageData);
    }
}

module.exports = app;
