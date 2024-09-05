const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const app = express();
const port = 8080;
const SECRET_KEY = 'afterlife897787';

app.use(express.json());

app.post('/api/proxy/change/port', (req, res) => {

});
app.post('/api/ipsetadd', (req, res) => {
    const { key, ipplayer } = req.body;

    if (!key || !ipplayer) {
        return res.status(400).send('Missing required parameters');
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }

    exec(`sudo ipset add ${ipsetName} ${ipplayer}`, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).send(`Error adding IP to ipset: ${stderr}`);
        }

        res.status(200).send('IP added to whitelist');
    });
});
app.post('/api/ipsetdel', (req, res) => {
    const { key, ipplayer } = req.body;

    if (!key || !ipplayer) {
        return res.status(400).send('Missing required parameters');
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }

    exec(`sudo ipset del ${ipsetName} ${ipplayer}`, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).send(`Error removing IP from ipset: ${stderr}`);
        }

        res.status(200).send('IP removed from whitelist');
    });
});


app.listen(port, () => {
    console.log(`Proxy API listening on port ${port}`);
});