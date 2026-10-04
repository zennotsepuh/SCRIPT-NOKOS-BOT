const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const Pino = require('pino');
const readline = require('readline');
const api = require('./api');
const config = require('./config');

const logger = Pino({ level: 'silent' });

// State session user (untuk multi-step command)
const sessions = {};

// Helper: kirim pesan
const send = (sock, jid, text) =>
    sock.sendMessage(jid, { text: String(text) });

// Helper: format rupiah
const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

// Helper: tanya via readline (untuk pairing code)
const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(text, (ans) => {
        rl.close();
        resolve(ans.trim());
    }));
};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false, // matikan QR, pakai pairing
        auth: state,
        browser: ['Nokos Bot', 'Chrome', '1.0.0']
    });

    // === PAIRING CODE ===
    if (!sock.authState.creds.registered) {
        console.log('\n=== PAIRING MODE ===');
        const phoneNumber = await question('Masukkan nomor WhatsApp bot (contoh: 628123456789): ');

        if (!/^\d{10,15}$/.test(phoneNumber)) {
            console.log('❌ Nomor tidak valid. Keluar.');
            process.exit(1);
        }

        try {
            const code = await sock.requestPairingCode(phoneNumber);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log(`\n✅ PAIRING CODE: ${formatted}`);
            console.log('📱 Buka WhatsApp → Perangkat Tertaut → Tautkan dengan nomor telepon');
            console.log('   Masukkan kode di atas.\n');
        } catch (e) {
            console.log('❌ Gagal minta pairing code:', e.message);
            process.exit(1);
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    // === PAIRING CODE ===
    if (qr && !sock.authState.creds.registered) {
        try {
            const phoneNumber = await question('Nomor WA bot (contoh: 628123456789): ');
            const code = await sock.requestPairingCode(phoneNumber);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log(`\n✅ PAIRING CODE: ${formatted}\n`);
            console.log('📱 Masukin di WhatsApp → Perangkat Tertaut\n');
        } catch (e) {
            console.log('❌ Gagal minta pairing code:', e.message);
        }
    }

    // === CONNECTED ===
    if (connection === 'open') {
        console.log('✅ BOT CONNECTED KE WHATSAPP!');
        if (isNewLogin) console.log('🎉 Pairing berhasil!');
    }

    // === DISCONNECTED ===
    if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log('❌ Koneksi tertutup. Status:', statusCode);

        // 515 = pairing sukses, butuh restart
        // 401 = logged out, jangan reconnect
        // Selain itu = auto reconnect
        if (statusCode === DisconnectReason.loggedOut) {
            console.log('🚫 Logged out. Hapus folder auth/ lalu jalankan ulang.');
            process.exit(1);
        } else {
            console.log('🔄 Reconnecting dalam 5 detik...');
            setTimeout(() => startBot(), 5000);
        }
    }
});

    // === HANDLER PESAN ===
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            ''
        ).trim();

        if (!text.startsWith(config.PREFIX)) return;
        const [cmd, ...args] = text.slice(config.PREFIX.length).split(/\s+/);
        const command = cmd.toLowerCase();

        try {
            switch (command) {
                // === 1. PROFILE ===
                case 'profile': case 'me': {
                    const p = await api.getProfile();
                    await send(sock, jid,
`👤 PROFIL AKUN

📧 Email : ${p.email || '-'}
🏷️ Nama  : ${p.name || '-'}
💰 Saldo : ${rp(p.balance)}`
                    );
                    break;
                }

                // === 2. COUNTRIES ===
                case 'countries': case 'negara': {
                    const server = args[0];
                    if (!server) return send(sock, jid, '❌ Format: `.countries 1` (server 1-4)');
                    const data = await api.getCountries(server);
                    const list = Array.isArray(data) ? data : (data.data || data.result || []);
                    if (!list.length) return send(sock, jid, '⚠️ Tidak ada data negara.');
                    let out = `🌍 *DAFTAR NEGARA — Server ${server}*\n\n`;
                    list.slice(0, config.LIMIT).forEach((c, i) => {
                        const code = c.code || c.id || c.country || '-';
                        const name = c.name || c.country_name || c.nama || '-';
                        out += `${i + 1}. [${code}] ${name}\n`;
                    });
                    out += `\n_Total: ${list.length}_`;
                    await send(sock, jid, out);
                    break;
                }

                // === 3. DEPOSIT CREATE ===
                case 'deposit': {
                    const nominal = parseInt(args[0]);
                    const code = args[1] || undefined;
                    if (!nominal || nominal < 1000)
                        return send(sock, jid, '❌ Format: `.deposit 10000 [kodeCashback]`');
                    const d = await api.createDeposit(nominal, code);
                    const id = d.id || d.deposit_id;
                    const qr = d.qr || d.qr_data || d.qris || '-';
                    await send(sock, jid,
`💳 DEPOSIT BARU

🆔 ID      : ${id}
💵 Nominal : ${rp(nominal)}${d.cashback ? `\n🎁 Cashback: ${rp(d.cashback)}` : ''}
📌 Status  : ${d.status || 'pending'}

${qr !== '-' ? `📷 QRIS:\n${qr}\n` : ''}
Cek status: \`.depstatus ${id}\``
                    );
                    break;
                }

                // === 4. DEPOSIT STATUS ===
                case 'depstatus': {
                    const id = args[0];
                    if (!id) return send(sock, jid, '❌ Format: `.depstatus DEPOSIT_ID`');
                    const d = await api.depositStatus(id);
                    await send(sock, jid,
`📊 STATUS DEPOSIT

🆔 ID     : ${id}
💵 Nominal: ${rp(d.nominal || d.amount)}
📌 Status : ${d.status || '-'}
🕐 Update : ${d.updated_at || d.created_at || '-'}`
                    );
                    break;
                }

                // === 5. DEPOSIT CANCEL ===
                case 'depcancel': {
                    const id = args[0];
                    if (!id) return send(sock, jid, '❌ Format: `.depcancel DEPOSIT_ID`');
                    const r = await api.depositCancel(id);
                    await send(sock, jid, `✅ Deposit ${id} dibatalkan.\n${r.message || ''}`);
                    break;
                }

                // === 6. DEPOSIT HISTORY ===
                case 'dephistory': {
                    const status = args[0];
                    const data = await api.depositHistory(20, status);
                    const list = Array.isArray(data) ? data : (data.data || data.history || []);
                    if (!list.length) return send(sock, jid, '⚠️ Belum ada riwayat deposit.');
                    let out = `📜 *RIWAYAT DEPOSIT*${status ? ` (${status})` : ''}\n\n`;
                    list.forEach((d, i) => {
                        out += `${i + 1}. ${rp(d.nominal || d.amount)} — *${d.status}*\n   ID: ${d.id}\n   ${d.created_at || ''}\n`;
                    });
                    await send(sock, jid, out);
                    break;
                }

                // === 7. SERVICES ===
                case 'services': case 'layanan': {
                    const [server, country] = args;
                    if (!server || !country)
                        return send(sock, jid, '❌ Format: `.services 1 6`');
                    const data = await api.getServices(server, country);
                    const list = Array.isArray(data) ? data : (data.data || data.services || []);
                    if (!list.length) return send(sock, jid, '⚠️ Tidak ada layanan.');
                    let out = `🛠️ *LAYANAN — Server ${server} / Negara ${country}*\n\n`;
                    list.slice(0, config.LIMIT).forEach((s, i) => {
                        const kode = s.produk || s.code || s.id || '-';
                        const nama = s.name || s.nama || s.service_name || '-';
                        const prov = s.provider ? ` | provider=${s.provider}` : '';
                        const harga = s.price || s.harga ? ` | ${rp(s.price || s.harga)}` : '';
                        out += `${i + 1}. [${kode}] ${nama}${prov}${harga}\n`;
                    });
                    out += `\n_Pakai \`.order\` untuk memesan._`;
                    await send(sock, jid, out);
                    break;
                }

                // === 8. OPERATORS ===
                case 'operators': case 'operator': {
                    const [server, country] = args;
                    if (!server || !country)
                        return send(sock, jid, '❌ Format: `.operators 1 6`');
                    const data = await api.getOperators(server, country);
                    const list = Array.isArray(data) ? data : (data.data || data.operators || []);
                    if (!list.length) return send(sock, jid, '⚠️ Tidak ada operator.');
                    let out = `📡 *OPERATOR — Server ${server} / Negara ${country}*\n\n`;
                    out += `0. [any] Random Operator\n`;
                    list.forEach((o, i) => {
                        const kode = o.operator || o.code || o.id || '-';
                        const nama = o.name || o.nama || '-';
                        out += `${i + 1}. [${kode}] ${nama}\n`;
                    });
                    await send(sock, jid, out);
                    break;
                }

                // === 9. ORDER STATUS (cek OTP) ===
                case 'status': {
                    const id = args[0];
                    if (!id) return send(sock, jid, '❌ Format: `.status ORDER_ID`');
                    const o = await api.orderStatus(id);
                    await send(sock, jid,
`📦 STATUS ORDER

🆔 ID     : ${id}
📱 Nomor  : ${o.number || '-'}
🔑 OTP    : ${o.otp || 'Waiting'}
📌 Status : ${o.status || '-'}
💵 Harga  : ${rp(o.price)}`
                    );
                    break;
                }

                // === 10. ORDER CANCEL (refund) ===
                case 'cancel': {
                    const id = args[0];
                    if (!id) return send(sock, jid, '❌ Format: `.cancel ORDER_ID`');
                    const r = await api.orderCancel(id);
                    await send(sock, jid, `✅ Order ${id} dibatalkan. Saldo direfund.\n${r.message || ''}`);
                    break;
                }

                // === 11. ORDER HISTORY ===
                case 'history': {
                    const data = await api.orderHistory(20);
                    const list = Array.isArray(data) ? data : (data.data || data.history || []);
                    if (!list.length) return send(sock, jid, '⚠️ Belum ada riwayat order.');
                    let out = `📜 *RIWAYAT ORDER*\n\n`;
                    list.forEach((o, i) => {
                        out += `${i + 1}. ${o.number || '-'} — *${o.status}*\n   OTP: ${o.otp || 'Waiting'} | ${rp(o.price)}\n   ID: ${o.id}\n`;
                    });
                    await send(sock, jid, out);
                    break;
                }

                // === 12-15. ORDER CREATE (semua server) ===
                case 'order': {
                    // Format: .order <server> <country> <produk> [operator|provider]
                    const [server, country, produk, extra] = args;
                    if (!server || !country || !produk) {
                        return send(sock, jid,
`❌ Format Order:

Server 1: \`.order 1 6 wa any\`
Server 2: \`.order 2 6 wa 3320\`
Server 3: \`.order 3 6 wa\`
Server 4: \`.order 4 id tw 532\``
                        );
                    }

                    const s = parseInt(server);
                    const payload = { server: s, country, produk };

                    if (s === 1) {
                        payload.operator = extra || 'any';
                    } else if (s === 2 || s === 4) {
                        if (!extra) return send(sock, jid, `❌ Server ${s} butuh provider. Contoh: \`.order ${s} ${country} ${produk} PROVIDER\``);
                        payload.provider = extra;
                    }
                    // server 3: tanpa operator/provider

                    const o = await api.createOrder(payload);
                    await send(sock, jid,
`✅ ORDER BERHASIL

🆔 ID     : ${o.id}
🌍 Negara : ${o.country_name || country}
📱 Nomor  : ${o.number}
💵 Harga  : ${rp(o.price)}
📌 Status : ${o.status || 'pending'}
🔑 OTP    : ${o.otp || 'Waiting'}

Cek OTP: \`.status ${o.id}\`
Batal  : \`.cancel ${o.id}\``
                    );
                    break;
                }

                // === MENU ===
                case 'menu': case 'help': case 'start': {
                    await send(sock, jid,
`🤖 NOKOS BOT MENU

👤 \`.profile\` — Info akun & saldo

🌍 \`.countries <server>\` — Daftar negara
   Contoh: \`.countries 1\`

💳 \`.deposit <nominal> [kode]\` — Buat QRIS
📊 \`.depstatus <id>\` — Cek status deposit
❌ \`.depcancel <id>\` — Batal deposit
📜 \`.dephistory [status]\` — Riwayat deposit

🛠️ \`.services <server> <country>\` — Daftar layanan
📡 \`.operators <server> <country>\` — Daftar operator

🛒 \`.order <server> <country> <produk> [op/provider]\`
   • S1: \`.order 1 6 wa any\`
   • S2: \`.order 2 6 wa 3320\`
   • S3: \`.order 3 6 wa\`
   • S4: \`.order 4 id tw 532\`

📦 \`.status <id>\` — Cek OTP
❌ \`.cancel <id>\` — Batal + refund
📜 \`.history\` — Riwayat order

_Server 1 & 4 pakai operator/provider_
_Server 2 & 4 pakai provider dari /services_`
                    );
                    break;
                }

                default:
                    await send(sock, jid, `❓ Command tidak dikenal: *${command}*\nKetik \`.menu\` untuk bantuan.`);
            }
        } catch (err) {
            const msg = err.response?.data?.message || err.response?.data?.error || err.message;
            console.error('❌ Error:', msg);
            await send(sock, jid, `❌ *Error:* ${msg}`);
        }
    });
}

startBot().catch((e) => console.error('Fatal:', e));
