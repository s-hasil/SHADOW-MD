global.crypto = require('crypto');
const { start } = require('./lib/client');
const { spawn } = require('child_process');
const path = require('path');
const CFonts = require('cfonts');

console.clear();
CFonts.say('SHADOW MD', {
    font: 'block',
    align: 'center',
    colors: ['cyan', 'blue'],
    background: 'transparent',
    letterSpacing: 1,
    lineHeight: 1,
    space: true,
    maxLength: '0',
});

CFonts.say('By JoyBoySer', {
    font: 'console',
    align: 'center',
    colors: ['candy'],
});

function startBot() {
    start().catch(err => {
        console.error("Critical Error:", err);
        console.log("Restarting...");
        startBot();
    });
}

startBot();
