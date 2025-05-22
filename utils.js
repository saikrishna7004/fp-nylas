const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, './accessTokens.json');

function loadTokens() {
    if (!fs.existsSync(TOKEN_FILE)) {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({}));
    }
    const raw = fs.readFileSync(TOKEN_FILE);
    return JSON.parse(raw);
}

function saveTokens(tokens) {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

module.exports = {
    loadTokens,
    saveTokens,
};
