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
        return res.status(200).send();
    }

    try {
        const encodedMessage = message.data;
        const decodedMessage = JSON.parse(
            Buffer.from(encodedMessage, "base64").toString("utf-8")
        );

        console.log("decoded message: ", decodedMessage);
        if (!decodedMessage.emailAddress) {
            throw new Error("Invalid message format!");
        }
        
        const emailCreds = accessTokens[decodedMessage.emailAddress];

        if (!emailCreds)    throw new Error(`${decodedMessage.emailAddress} not authenticated!`);

        await getMessages(emailCreds, decodedMessage.emailAddress, decodedMessage.historyId);
    } catch (err) {
        // Sending back a status code of 200 to acknowledge google that message is recieved
        // otherwise it floods us with same messages again and again until it gets an acknowledgement (can only be done via 200 status code)
        
        console.log("error: ", err);
        return res.status(200).send();
    }
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
        startHistoryId: emailCreds.historyId
    })

    console.log("messages: ", JSON.stringify(messagesRes));

    if (!messagesRes || !messagesRes.data || !messagesRes.data.history) {
        throw new Error("no messages found for user: " + userEmail);
    }

    for (const historyRecord of messagesRes.data.history) {
        if (!historyRecord.messagesAdded)   continue;

        for (let message of historyRecord.messagesAdded) {
            if (!message)   continue;
            message = message.message; 


            if (message.labelIds && (message.labelIds.includes('SENT') || message.labelIds.includes('INBOX'))) {
                // process the message 
                const messageData = await gmailClient.users.messages.get({
                    userId: 'me',
                    id: message.id,
                    format: 'full',
                })

                console.log('messageData: ', JSON.stringify(messageData));
            }
        }

    }

    // we have to update the historyId each time a new message is recieved
    // we fetch messages from the previous historyId, and then update userInfo with
    // the historyId that we have recieved latest.
    accessTokens[userEmail] = { ...emailCreds, historyId: historyId };
    console.log('accessTokens: ', accessTokens);
}

module.exports = app;
