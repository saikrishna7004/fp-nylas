const express = require('express');
const dotenv = require('dotenv');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { loadTokens, saveTokens } = require('./utils');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CLIENT_REDIRECT_URI
);

let accessTokens = loadTokens();

const messagesFilePath = path.join(__dirname, 'messages.json');

const loadMessages = () => {
    try {
        return JSON.parse(fs.readFileSync(messagesFilePath, 'utf8'));
    } catch (err) {
        return [];
    }
};

const saveMessages = (messages) => {
    fs.writeFileSync(messagesFilePath, JSON.stringify(messages, null, 2));
};

app.get('/connect', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'],
        prompt: 'consent'
    });

    res.redirect(url);
});

app.get('/', (req, res) => {
    res.status(200).send("Hello World!");
});

app.post('/webhook', async (req, res) => {
    console.log("Gmail webhook received");
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

        if (!emailCreds) throw new Error(`${decodedMessage.emailAddress} not authenticated!`);

        await getMessages(emailCreds, decodedMessage.emailAddress, decodedMessage.historyId);
    } catch (err) {
        // Sending back a status code of 200 to acknowledge google that message is recieved
        // otherwise it floods us with same messages again and again until it gets an acknowledgement (can only be done via 200 status code)

        console.log("error: ", err);
        return res.status(200).send();
    }
    return res.status(200).send();
});

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

        accessTokens[userEmail] = {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiry: tokens.expiry_date,
            watchExpiration: expiration,
            historyId: historyId
        }
        saveTokens(accessTokens);

        console.log('accessTokens: ', JSON.stringify(accessTokens))

        res.send(`✅ Watch set for ${userEmail}. historyId: ${historyId}`);
    } catch (err) {
        console.log("error: ", err);
        res.status(500).send("failed to setup gmail watch");
    }
});

app.get('/messages', (req, res) => {
    const messages = loadMessages();

    const rows = messages.map(msg => {
        let decodedContent = '';
        try {
            decodedContent = Buffer.from(msg.content, 'base64').toString('utf-8');
        } catch (err) {
            decodedContent = '[Error decoding content]';
        }

        return `
            <tr>
                <td><a href="/message/${msg.id}">${msg.subject}</a></td>
                <td>${msg.from}</td>
                <td>${msg.to}</td>
                <td>${decodedContent.substring(0, 100)}...</td>
            </tr>
        `;
    }).join('');

    res.status(200).send(`
        <html>
            <head>
                <title>Messages</title>
                <style>
                    table {
                        width: 100%;
                        border-collapse: collapse;
                    }
                    th, td {
                        padding: 8px;
                        border: 1px solid #ccc;
                        text-align: left;
                    }
                    th {
                        background-color: #f4f4f4;
                    }
                </style>
            </head>
            <body>
                <h1>Messages</h1>
                <table>
                    <thead>
                        <tr>
                            <th>Subject</th>
                            <th>From</th>
                            <th>To</th>
                            <th>Content Preview</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </body>
        </html>
    `);
});

app.get('/message/:id', async (req, res) => {
    const messages = loadMessages();
    const message = messages.find(msg => msg.id === req.params.id);
    if (!message) {
        return res.status(404).send('Message not found');
    }

    let decodedContent = '';
    try {
        decodedContent = Buffer.from(message.htmlContent, 'base64').toString('utf-8');

    } catch (err) {
        decodedContent = '[Error decoding message content]';
    }

    try {
        decodedContent = Buffer.from(message.htmlContent, 'base64').toString('utf-8');
        message.attachments.forEach(att => {
            if (att.contentId) {
                const cidRef = `cid:${att.contentId}`;
                const inlineUrl = `/inline/${encodeURIComponent(message.id)}/${encodeURIComponent(att.attachmentId)}`;
                decodedContent = decodedContent.replaceAll(cidRef, inlineUrl);
            }
        });
    } catch (err) {
        decodedContent = '[Error decoding HTML content]';
    }

    const emailCreds = accessTokens[message.userEmail];
    if (!emailCreds) {
        return res.status(400).send('User credentials not found for this message.');
    }

    oauth2Client.setCredentials({
        access_token: emailCreds.accessToken,
        refresh_token: emailCreds.refreshToken,
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
        expiry_date: emailCreds.expiry
    });

    const attachmentsHtml = await Promise.all(message.attachments.map(async (att) => {
        try {
            const downloadUrl = await getAttachmentAndSave(oauth2Client, message.id, att.attachmentId, att.mimeType, att.filename);
            return `<a href="${downloadUrl}" download>${att.filename}</a>`;
        } catch (e) {
            return `<span>${att.filename} (error loading)</span>`;
        }
    }));

    res.status(200).send(`
        <html>
            <head><title>Message</title></head>
            <body>
                <h1>Message</h1>
                <div><strong>Subject:</strong> ${message.subject}</div>
                <div><strong>From:</strong> ${message.from}</div>
                <div><strong>Content:</strong></div>
                <div>${decodedContent}</div>
                <h2>Attachments:</h2>
                ${attachmentsHtml.join('<br>')}
            </body>
        </html>
    `);
});

app.get('/attachment', async (req, res) => {
    const { messageId, attachmentId, userEmail } = req.query;
    const emailCreds = accessTokens[userEmail];
    if (!emailCreds) {
        return res.status(400).send("No email creds found for user: " + userEmail);
    }

    oauth2Client.setCredentials({
        access_token: emailCreds.accessToken,
        refresh_token: emailCreds.refreshToken,
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
        expiry_date: emailCreds.expiry
    });

    try {
        const url = await getAttachmentAndSave(oauth2Client, messageId, attachmentId, 'image/png');
        res.status(200).send(`
            <html>
              <head><title>Attachment</title></head>
              <body>
                <h2>Click below to open the attachment:</h2>
                <a href="${url}" target="_blank">Open Attachment</a>
              </body>
            </html>
        `);
    } catch (err) {
        console.error(err);
        res.status(500).send("Failed to fetch attachment");
    }
});

app.get('/inline/:messageId/:attachmentId', async (req, res) => {
    const { messageId, attachmentId } = req.params;
    const messages = loadMessages();
    const message = messages.find(msg => msg.id === messageId);
    if (!message) return res.status(404).send('Message not found');

    const emailCreds = accessTokens[message.userEmail];
    if (!emailCreds) return res.status(400).send("User credentials not found");

    oauth2Client.setCredentials({
        access_token: emailCreds.accessToken,
        refresh_token: emailCreds.refreshToken,
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
        expiry_date: emailCreds.expiry
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const attachmentRes = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId
    });

    const att = message.attachments.find(a => a.attachmentId === attachmentId);
    if (!att) return res.status(404).send('Attachment not found');

    let data = attachmentRes.data.data;
    data = data.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(data, 'base64');

    res.setHeader('Content-Type', att.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${att.filename}"`);
    res.send(buffer);
});


const getMessages = async (emailCreds, userEmail, historyId) => {
    oauth2Client.setCredentials({
        access_token: emailCreds.accessToken,
        refresh_token: emailCreds.refreshToken,
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
        expiry_date: emailCreds.expiry
    });

    const gmailClient = google.gmail({
        version: "v1",
        auth: oauth2Client
    });

    const messagesRes = await gmailClient.users.history.list({
        userId: 'me',
        startHistoryId: emailCreds.historyId
    });

    if (!messagesRes || !messagesRes.data || !messagesRes.data.history) {
        throw new Error("no messages found for user: " + userEmail);
    }

    const messages = loadMessages();

    for (const historyRecord of messagesRes.data.history) {
        if (!historyRecord.messagesAdded) continue;

        for (let message of historyRecord.messagesAdded) {
            if (!message) continue;
            message = message.message;

            if (message.labelIds && (message.labelIds.includes('SENT') || message.labelIds.includes('INBOX'))) {
                const messageData = await gmailClient.users.messages.get({
                    userId: 'me',
                    id: message.id,
                    format: 'full',
                });
                console.log('messageData: ', JSON.stringify(messageData));

                const {plainText, htmlContent, attachments} = parseGmailPayload(messageData.data.payload);

                const messageDetails = {
                    id: message.id,
                    from: extractEmail(messageData.data.payload.headers.find(header => header.name === 'From').value),
                    to: extractEmail(messageData.data.payload.headers.find(header => header.name === 'To').value),
                    subject: messageData.data.payload.headers.find(header => header.name === 'Subject').value,
                    content: plainText,
                    htmlContent: htmlContent,
                    attachments: attachments,
                    userEmail: userEmail,
                };

                messages.push(messageDetails);
            }
        }
    }

    saveMessages(messages);

    accessTokens[userEmail] = { ...emailCreds, historyId: historyId };
    saveTokens(accessTokens);
};

async function getAttachmentAndSave(auth, messageId, attachmentId, mimeType, filename) {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId
    });

    let data = res.data.data;
    data = data.replace(/-/g, '+').replace(/_/g, '/');

    const buffer = Buffer.from(data, 'base64');
    const filePath = path.join(__dirname, 'downloads', filename);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);

    return `/download/${encodeURIComponent(filename)}`;
}

app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'downloads', filename);
    res.download(filePath, filename, (err) => {
        if (err) {
            console.error('Download error:', err);
            res.status(500).send('Failed to download attachment.');
        }
    });
});

function parseGmailPayload(payload) {
    let plainText = null;
    let htmlContent = null;
    const attachments = [];
    function traverse(part) {
        if (part.parts && part.parts.length > 0) {
            part.parts.forEach(traverse);
            return;
        }
        const { mimeType, filename, body } = part;
        if (mimeType === 'text/plain' && body?.data) {
            plainText ??= body.data;
        } else if (mimeType === 'text/html' && body?.data) {
            htmlContent ??= body.data;
        } else if (filename && body?.attachmentId) {
            const contentIdHeader = part.headers?.find(h => h.name.toLowerCase() === 'content-id');
            const contentId = contentIdHeader?.value?.replace(/[<>]/g, '') || null;
            attachments.push({
                filename,
                mimeType,
                attachmentId: body.attachmentId,
                contentId: contentId
            });
        }
    }
    traverse(payload);
    return { plainText, htmlContent, attachments };
}

function extractEmail(headerValue) {
    const match = headerValue.match(/<([^>]+)>/);
    return match ? match[1] : headerValue;
}

module.exports = app;
