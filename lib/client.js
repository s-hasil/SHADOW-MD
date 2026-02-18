const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    jidDecode,
    proto,
    getContentType,
    Browsers,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const fs = require('fs-extra');
const path = require('path');
const { Boom } = require("@hapi/boom");
const util = require("util");
const PhoneNumber = require('awesome-phonenumber');
const { smsg } = require('../lib/myfuncn'); // Assuming this helper exists and is compatible
const Config = require('../config');
const events = require('./commands');
const { sck1, sck, plugindb } = require("../lib"); // Database models

// Initialize Store
const store = makeInMemoryStore({
    logger: pino().child({ level: "silent", stream: "store" })
});

// Bind store to file
const storePath = path.join(__dirname, 'store.json');
setInterval(() => {
    if (store.writeToFile) {
        store.writeToFile(storePath);
    }
}, 30 * 1000);

// Main Connection Function
async function start() {
    process.on('unhandledRejection', (err) => console.error(err));

    // Ensure auth directory exists
    const authDir = path.join(__dirname, 'auth_info_baileys');
    if (!fs.existsSync(authDir)) {
        fs.ensureDirSync(authDir);
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    // const { version, isLatest } = await fetchLatestBaileysVersion();
    const version = [2, 3000, 1015901307];
    console.log(`Using Baileys v${version.join('.')}`);

    const client = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: !Config.PAIRING_NUMBER,
        browser: Browsers.macOS("Desktop"),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        version,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        fireInitQueries: false,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        getMessage: async (key) => {
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg.message || undefined;
            }
            return { conversation: "Hello World" };
        }
    });

    if (Config.PAIRING_NUMBER && !client.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let params = { phoneNumber: Config.PAIRING_NUMBER }
                let code = await client.requestPairingCode(Config.PAIRING_NUMBER);
                console.log(`\x1b[32mCODE: \x1b[36m${code?.match(/.{1,4}/g)?.join("-") || code}\x1b[0m`);
            } catch (err) {
                console.error("Failed to request pairing code:", err);
            }
        }, 3000);
    }

    store.bind(client.ev);

    // Helpers
    client.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {};
            return decode.user && decode.server && decode.user + '@' + decode.server || jid;
        } else return jid;
    };

    client.getName = async (jid, withoutContact = false) => {
        const id = client.decodeJid(jid);
        withoutContact = client.withoutContact || withoutContact;
        let v;
        if (id.endsWith("@g.us")) return new Promise(async (resolve) => {
            v = store.contacts[id] || {};
            if (!(v.name || v.subject)) v = client.groupMetadata(id) || {};
            resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'));
        });
        else v = id === '0@s.whatsapp.net' ? {
            id,
            name: 'WhatsApp'
        } : id === client.decodeJid(client.user.id) ?
            client.user :
            (store.contacts[id] || {});
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international');
    };

    // Handle Connection Updates
    client.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            console.log("Connection Closed:", lastDisconnect?.error);
            let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
            if (reason === DisconnectReason.badSession) {
                console.log(`Bad Session File, Please Delete ${authDir} and Scan Again`);
                process.exit();
            } else if (reason === DisconnectReason.connectionClosed) {
                console.log("Connection closed, reconnecting....");
                start();
            } else if (reason === DisconnectReason.connectionLost) {
                console.log("Connection Lost from Server, reconnecting...");
                start();
            } else if (reason === DisconnectReason.connectionReplaced) {
                console.log("Connection Replaced, Another New Session Opened, Please Close Current Session First");
                process.exit();
            } else if (reason === DisconnectReason.loggedOut) {
                console.log(`Device Logged Out, Please Delete ${authDir} and Scan Again.`);
                process.exit();
            } else if (reason === DisconnectReason.restartRequired) {
                console.log("Restart Required, Restarting...");
                start();
            } else if (reason === DisconnectReason.timedOut) {
                console.log("Connection TimedOut, Reconnecting...");
                start();
            } else {
                console.log(`Unknown DisconnectReason: ${reason}|${connection}`);
                start();
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp');
            console.log('⬇️ Installing External Plugins...');
            // Optional: plugin loader logic here if safe
            // Keeping safe: Just requiring local commands
            const commandsDir = path.join(__dirname, '..', 'commands');
            if (fs.existsSync(commandsDir)) {
                fs.readdirSync(commandsDir).forEach((plugin) => {
                    if (path.extname(plugin).toLowerCase() == ".js") {
                        try {
                            require(path.join(commandsDir, plugin));
                        } catch (e) {
                            console.error(`Error loading plugin ${plugin}:`, e);
                        }
                    }
                });
            }
            console.log(`✅ Plugins Loaded. Total: ${events.commands.length}`);

            // Notify Owner
            const ownerNumber = Config.owner[0] + "@s.whatsapp.net";
            await client.sendMessage(ownerNumber, {
                text: `_Shadow-MD has started successfully!_\n_Version: ${require('../package.json').version}_`
            });
        }
    });

    // Handle Credentials Update
    client.ev.on('creds.update', saveCreds);

    // Sync Contacts to DB
    client.ev.on('contacts.upsert', async (contacts) => {
        const insertContact = (newContact) => {
            for (const contact of newContact) {
                if (store.contacts[contact.id]) {
                    Object.assign(store.contacts[contact.id], contact);
                } else {
                    store.contacts[contact.id] = contact;
                }
            }
            return;
        };
        insertContact(contacts);
    });

    client.ev.on('contacts.update', async (update) => {
        for (let contact of update) {
            let id = client.decodeJid(contact.id);
            if (store && store.contacts) store.contacts[id] = { id, name: contact.notify };

            // Sync with DB
            try {
                let usr = await sck1.findOne({ id: id });
                if (!usr) {
                    await new sck1({ id: id, name: contact.notify }).save();
                } else {
                    await sck1.updateOne({ id: id }, { name: contact.notify });
                }
            } catch (err) {
                // Ignore DB errors in background sync
            }
        }
    });

    // Handle Messages
    client.ev.on('messages.upsert', async chatUpdate => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;

            mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;
            if (mek.key && mek.key.remoteJid === 'status@broadcast') return;

            // Process message (smsg helper)
            let m = await smsg(client, mek, store);
            if (!m.message) return;

            // Command Logic
            const prefix = Config.HANDLERS[0] || '.';
            const isCmd = m.body.startsWith(prefix);
            const cmdName = isCmd ? m.body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : false;
            const text = m.body.slice(isCmd ? prefix.length + cmdName.length : 0).trim();
            const args = text.split(' ');

            // Log Message
            const isGroup = m.isGroup;
            const sender = m.sender;
            const pushName = m.pushName || "User";
            console.log(`[${isGroup ? 'GROUP' : 'PRIVATE'}] From: ${pushName} (${sender}) | Message: ${m.body}`);

            // Find and Execute Command
            const cmd = events.commands.find((cmd) => cmd.pattern === cmdName) || events.commands.find((cmd) => cmd.alias && cmd.alias.includes(cmdName));

            if (isCmd && cmd) {
                try {
                    // Permission Checks (simple example)
                    // ... (Add your permission logic here)

                    await cmd.function(client, m, text, { args, isCmd, body: m.body });
                } catch (e) {
                    console.error(`Error executing command ${cmdName}:`, e);
                    m.reply(`Error executing command: ${e.message}`);
                }
            }

            // Events (body/text/etc)
            events.commands.map(async (command) => {
                if (!isCmd) {
                    // Match 'on' events
                    if (command.on === "body" && m.body) {
                        command.function(client, m, { args, body: m.body });
                    } else if (command.on === "text" && m.text) {
                        command.function(client, m, args, { body: m.body });
                    }
                    // Add other event types here
                }
            });
        } catch (err) {
            console.error(err);
        }
    });

    // Group Participants Update
    client.ev.on('group-participants.update', async (anu) => {
        try {
            let metadata = await client.groupMetadata(anu.id);
            let participants = anu.participants;
            for (let num of participants) {
                // Antifake Logic
                if (Config.antifake) {
                    const countryCode = PhoneNumber('+' + num.split('@')[0]).getCountryCode();
                    if (Config.antifake.includes(countryCode)) {
                        await client.sendMessage(anu.id, { text: `${countryCode} number is not allowed` });
                        await client.groupParticipantsUpdate(anu.id, [num], 'remove');
                        continue;
                    }
                }

                // Welcome/Goodbye/Promote/Demote Logic
                let checkinfo = await sck.findOne({ id: anu.id });
                if (checkinfo) {
                    let events = checkinfo.events || "false";
                    let ppuser;
                    try {
                        ppuser = await client.profilePictureUrl(num, 'image');
                    } catch {
                        ppuser = 'https://i0.wp.com/www.gambarunik.id/wp-content/uploads/2019/06/Top-Gambar-Foto-Profil-Kosong-Lucu-Tergokil-.jpg';
                    }

                    if (anu.action == 'add' && events == "true") {
                        let welcome_messages = checkinfo.welcome
                            .replace(/@user/gi, `@${num.split("@")[0]}`)
                            .replace(/@gname/gi, metadata.subject)
                            .replace(/@desc/gi, metadata.desc || "")
                            .replace(/@count/gi, metadata.participants.length);

                        if (/@pp/g.test(welcome_messages)) {
                            await client.sendMessage(anu.id, {
                                image: { url: ppuser },
                                caption: welcome_messages.replace(/@pp/g, ''),
                                mentions: [num]
                            });
                        } else {
                            await client.sendMessage(anu.id, { text: welcome_messages, mentions: [num] });
                        }
                    } else if (anu.action == 'remove' && events == "true") {
                        let goodbye_messages = checkinfo.goodbye
                            .replace(/@user/gi, `@${num.split("@")[0]}`)
                            .replace(/@gname/gi, metadata.subject)
                            .replace(/@desc/gi, metadata.desc || "")
                            .replace(/@count/gi, metadata.participants.length);

                        if (/@pp/g.test(goodbye_messages)) {
                            await client.sendMessage(anu.id, {
                                image: { url: ppuser },
                                caption: goodbye_messages.replace(/@pp/g, ''),
                                mentions: [num]
                            });
                        } else {
                            await client.sendMessage(anu.id, { text: goodbye_messages, mentions: [num] });
                        }
                    } else if (anu.action == 'promote') {
                        await client.sendMessage(anu.id, {
                            image: { url: ppuser },
                            caption: `[ PROMOTE - DETECTED ]\n\nName : @${num.split("@")[0]}\nStatus : Member -> Admin\nGroup : ${metadata.subject}`,
                            mentions: [num]
                        });
                    } else if (anu.action == 'demote') {
                        await client.sendMessage(anu.id, {
                            image: { url: ppuser },
                            caption: `[ DEMOTE - DETECTED ]\n\nName : @${num.split("@")[0]}\nStatus : Admin -> Member`,
                            mentions: [num]
                        });
                    }
                }
            }
        } catch (err) {
            console.log(err);
        }
    });

    return client;
}

module.exports = { start };
